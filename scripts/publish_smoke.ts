import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  Contract,
  Interface,
  type Signer,
  Wallet,
  ZeroAddress,
  ZeroHash,
  getAddress,
  hexlify,
  keccak256,
  parseEther,
  randomBytes,
  solidityPacked,
} from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import { mergeInterfaces } from "./lib/extensions.js";
import { isSimulated } from "./lib/network.js";
import {
  type DynamicContract,
  type EntryPointLike,
  attestedEvents,
  buildPublishRequests,
  createAccountHelpers,
} from "./lib/managedAccount.js";

/**
 * `hardhat seed:publish-smoke`: publishes through the factory's live routing on a
 * simulated network (`hardhat node` or a fork) — docs/deploy-plan.md, steps 6–7.
 *
 *   1. Registers the schemas it needs, if missing.
 *   2. Creates a fresh account on the factory (createAccount is permissionless) with a
 *      local admin key, then publishes as its admin, and with a session key through
 *      an EntryPoint UserOp (`execute(account, multiPublish)`).
 *   3. With --account and --impersonate-admin: an admin publish on an existing account.
 *
 * Writes state, so it refuses to run on a live network.
 */

const SCHEMAS = { seed: "bytes32 seedSmoke", version: "bytes32 versionSmoke", property: "string valueSmoke" };

interface Args {
  parameters: string;
  account: string;
  impersonateAdmin: string;
}

type Connection = Awaited<ReturnType<HardhatRuntimeEnvironment["network"]["getOrCreate"]>>;

export default async function publishSmokeTask(args: Args, hre: HardhatRuntimeEnvironment) {
  const connection = await hre.network.getOrCreate();
  const parametersFile = args.parameters || `ignition/parameters/${connection.networkName}.json`;
  const parameters = JSON.parse(await readFile(path.resolve(hre.config.paths.root, parametersFile), "utf8"));
  const failures = await publishSmoke(connection, hre, {
    factory: parameters.SeedRollout?.factory,
    account: args.account,
    impersonateAdmin: args.impersonateAdmin,
  });
  if (failures.length) process.exitCode = 1;
}

export async function publishSmoke(
  connection: Connection,
  hre: HardhatRuntimeEnvironment,
  { factory: factoryAddress, account: existing, impersonateAdmin }: { factory: string; account?: string; impersonateAdmin?: string },
): Promise<string[]> {
  const { ethers, networkName } = connection;
  if (!(await isSimulated(connection))) {
    throw new Error(`seed:publish-smoke writes state; run it on a simulated network, not ${networkName}`);
  }
  if (!factoryAddress) throw new Error("No factory address (SeedRollout.factory)");

  const abi = async (name: string) => new Interface((await hre.artifacts.readArtifact(name)).abi);
  const accountInterface = mergeInterfaces(
    await abi("ManagedAccount"),
    await abi("AccountExtension"),
    await abi("SeedProtocolExtension"),
  );
  const [funder, admin, bundler] = await ethers.getSigners();
  const factory = new Contract(factoryAddress, await abi("ManagedAccountFactory"), funder);
  const entryPoint = new Contract(await factory.entrypoint(), await abi("EntryPoint"), ethers.provider);
  const { grantSessionKey, sendUserOp } = createAccountHelpers({ ethers });

  const failures: string[] = [];
  async function step(label: string, fn: () => Promise<string | null>) {
    let problem: string | null;
    try {
      problem = await fn();
    } catch (e) {
      problem = `threw: ${(e as Error).message.split("\n")[0]}`;
    }
    console.log(`${problem ? "FAIL" : "ok  "}  ${label}${problem ? ` — ${problem}` : ""}`);
    if (problem) failures.push(`${label}: ${problem}`);
  }

  /** Expects a seed + version + property attestation, all attested by `account`. */
  function checkAttested(eas: Contract, receipt: Parameters<typeof attestedEvents>[1], account: string): string | null {
    const attested = attestedEvents(eas, receipt);
    if (attested.length !== 3) return `${attested.length} attestations, expected 3`;
    const wrong = attested.find((a) => getAddress(a.attester) !== getAddress(account));
    return wrong ? `attested by ${wrong.attester}` : null;
  }

  // Schemas -------------------------------------------------------------------
  const probe = new Contract(existing || ZeroAddress, accountInterface, ethers.provider);
  const easAddress = existing ? await probe.getEas() : await easFromRouter(factory, accountInterface, ethers.provider);
  const eas = new Contract(easAddress, await abi("EAS"), ethers.provider);
  const schemaRegistry = new Contract(await eas.getSchemaRegistry(), await abi("SchemaRegistry"), funder);
  const setup = {
    seedSchemaUid: await ensureSchema(schemaRegistry, SCHEMAS.seed),
    versionSchemaUid: await ensureSchema(schemaRegistry, SCHEMAS.version),
    propertySchemaUid: await ensureSchema(schemaRegistry, SCHEMAS.property),
  };
  const publishData = accountInterface.encodeFunctionData("multiPublish", [buildPublishRequests(setup)]);

  // Fresh account ---------------------------------------------------------------
  // A random `_data` salt gives a new account each run.
  const salt = hexlify(randomBytes(32));
  const accountAddress: string = await factory.createAccount.staticCall(admin.address, salt);
  await (await factory.createAccount(admin.address, salt)).wait();
  await (await funder.sendTransaction({ to: accountAddress, value: parseEther("1") })).wait();
  const account = new Contract(accountAddress, accountInterface, admin) as DynamicContract;
  console.log(`Fresh account ${accountAddress} (admin ${admin.address})`);

  await step("admin publishes on a fresh account", async () => {
    const receipt = await (await admin.sendTransaction({ to: accountAddress, data: publishData })).wait();
    return checkAttested(eas, receipt, accountAddress);
  });

  await step("session key publishes through a UserOp (execute(account, multiPublish))", async () => {
    const sessionKey = Wallet.createRandom(ethers.provider);
    await grantSessionKey(account, admin, sessionKey.address, { approvedTargets: [accountAddress] });
    const { receipt, success, revertReason } = await sendUserOp({
      entryPoint: entryPoint as unknown as EntryPointLike,
      account,
      signer: sessionKey,
      callData: accountInterface.encodeFunctionData("execute", [accountAddress, 0n, publishData]),
      bundler: bundler as Signer,
    });
    if (!success) return `UserOp failed${revertReason ? ` (${revertReason})` : ""}`;
    return checkAttested(eas, receipt, accountAddress);
  });

  // Existing account --------------------------------------------------------------
  if (existing && impersonateAdmin) {
    await step(`admin ${impersonateAdmin} publishes on ${existing}`, async () => {
      const adminAddress = getAddress(impersonateAdmin);
      await ethers.provider.send("hardhat_impersonateAccount", [adminAddress]);
      await ethers.provider.send("hardhat_setBalance", [adminAddress, "0x" + parseEther("1").toString(16)]);
      const signer = await ethers.getSigner(adminAddress);
      const receipt = await (await signer.sendTransaction({ to: existing, data: publishData })).wait();
      return checkAttested(eas, receipt, existing);
    });
  }

  console.log(failures.length ? `\n${failures.length} step(s) failed.` : "\nAll publish steps passed.");
  return failures;
}

/** The Seed extension's pinned EAS, read through the factory's routing. */
async function easFromRouter(factory: Contract, accountInterface: Interface, provider: Connection["ethers"]["provider"]) {
  const impl = await factory.getImplementationForFunction(accountInterface.getFunction("getEas")!.selector);
  if (impl === ZeroAddress) throw new Error("The factory doesn't route getEas; run seed:replace-extension first");
  return new Contract(impl, accountInterface, provider).getEas();
}

/** Registers `schema` (no resolver, revocable) unless it already exists; returns its UID. */
async function ensureSchema(schemaRegistry: Contract, schema: string): Promise<string> {
  const uid = keccak256(solidityPacked(["string", "address", "bool"], [schema, ZeroAddress, true]));
  const record = await schemaRegistry.getSchema(uid);
  if (record.uid === ZeroHash) await (await schemaRegistry.register(schema, ZeroAddress, true)).wait();
  return uid;
}
