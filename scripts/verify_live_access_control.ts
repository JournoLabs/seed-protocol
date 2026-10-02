import { readFile } from "node:fs/promises";
import path from "node:path";
import { Contract, Interface, Wallet, ZeroAddress, getAddress } from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import { mergeInterfaces } from "./lib/extensions.js";
import {
  type SeedAddresses,
  buildSeedExtensions,
  defaultDeploymentId,
  loadRolloutParameters,
  loadSeedAddresses,
} from "./lib/seedDeployment.js";

/**
 * `hardhat seed:verify-live --account <address>`: checks a live account against a
 * SeedProtocol deployment using static calls only, so it's safe on any network
 * (docs/deploy-plan.md, P5 and step 5). Exits non-zero on any mismatch.
 *
 * Access control (access-control plan, step 9):
 *   - multiPublish from a random address reverts with Unauthorized;
 *   - setEas isn't routed;
 *   - getEas() is the expected EAS.
 * Executor routing:
 *   - getSeedExecutor() returns the new executor and EAS;
 *   - every registered selector routes to the expected implementation.
 */

const LEGACY_SET_EAS = new Interface(["function setEas(address)"]);

interface Args {
  account: string;
  parameters: string;
  deploymentId: string;
}

type Connection = Awaited<ReturnType<HardhatRuntimeEnvironment["network"]["getOrCreate"]>>;

export default async function verifyLiveTask(args: Args, hre: HardhatRuntimeEnvironment) {
  if (!args.account) throw new Error("--account is required (a test account on this network, input I3)");
  const connection = await hre.network.getOrCreate();
  const { chainId } = await connection.ethers.provider.getNetwork();
  const deploymentId = args.deploymentId || defaultDeploymentId(chainId);
  const parametersFile = args.parameters || `ignition/parameters/${connection.networkName}.json`;
  const parameters = JSON.parse(await readFile(path.resolve(hre.config.paths.root, parametersFile), "utf8"));
  const eas = parameters.SeedProtocol?.eas;
  if (!eas) throw new Error(`${parametersFile} has no SeedProtocol.eas`);

  console.log(`Network ${connection.networkName} (chain ${chainId}), deployment ${deploymentId}`);
  const failures = await verifyLiveAccessControl(connection, hre, {
    account: args.account,
    factory: (await loadRolloutParameters(hre, parametersFile)).factory,
    eas,
    addresses: await loadSeedAddresses(hre, deploymentId),
  });
  if (failures.length) process.exitCode = 1;
}

/** Runs every check and returns the failures (also logged). Tests call this directly. */
export async function verifyLiveAccessControl(
  { ethers }: Pick<Connection, "ethers">,
  hre: HardhatRuntimeEnvironment,
  { account, factory, eas, addresses }: { account: string; factory: string; eas: string; addresses: SeedAddresses },
): Promise<string[]> {
  const extensions = await buildSeedExtensions(hre, addresses);
  const abi = async (name: string) => new Interface((await hre.artifacts.readArtifact(name)).abi);
  const accountInterface = mergeInterfaces(
    await abi("ManagedAccount"),
    await abi("SeedProtocolExtension"),
    await abi("SeedExecutorRouterExtension"),
    LEGACY_SET_EAS,
  );
  const accountContract = new Contract(account, accountInterface, ethers.provider);
  const factoryContract = new Contract(factory, await abi("ManagedAccountFactory"), ethers.provider);

  const failures: string[] = [];
  async function check(label: string, fn: () => Promise<string | null>) {
    let problem: string | null;
    try {
      problem = await fn();
    } catch (e) {
      problem = `threw: ${(e as Error).message.split("\n")[0]}`;
    }
    console.log(`${problem ? "FAIL" : "ok  "}  ${label}${problem ? ` — ${problem}` : ""}`);
    if (problem) failures.push(`${label}: ${problem}`);
  }

  /**
   * Static call from `from`; returns the revert data, or null if it succeeded.
   * `from` is an unfunded random address, and nodes that charge fees on eth_call
   * (hardhat node on an OP chain adds the L1 data fee) would reject it before it
   * runs, so a state override gives it a balance for the call.
   */
  async function revertData(data: string, from: string): Promise<string | null> {
    try {
      await ethers.provider.send("eth_call", [{ to: account, data, from }, "latest", { [from]: { balance: "0xde0b6b3a7640000" } }]);
      return null;
    } catch (e: any) {
      const found = [e.data, e.info?.error?.data, e.error?.data].find((d) => typeof d === "string" && d.startsWith("0x"));
      if (found === undefined) throw e;
      return found;
    }
  }

  await check("account belongs to the factory", async () => {
    const actual = getAddress(await accountContract.factory());
    return actual === getAddress(factory) ? null : `account.factory() is ${actual}`;
  });

  await check("multiPublish from a random address reverts with Unauthorized", async () => {
    const stranger = Wallet.createRandom().address;
    const data = await revertData(accountInterface.encodeFunctionData("multiPublish", [[]]), stranger);
    if (data === null) return "call succeeded";
    const parsed = data === "0x" ? null : accountInterface.parseError(data);
    if (parsed?.name !== "Unauthorized") return `reverted with ${parsed?.name ?? data}`;
    return getAddress(parsed.args.caller) === stranger ? null : `Unauthorized(${parsed.args.caller}), expected ${stranger}`;
  });

  await check("setEas is not routed", async () => {
    const impl = await factoryContract.getImplementationForFunction(LEGACY_SET_EAS.getFunction("setEas")!.selector);
    return impl === ZeroAddress ? null : `routes to ${impl}`;
  });

  await check(`getEas() is ${eas}`, async () => {
    const actual = await accountContract.getEas();
    return getAddress(actual) === getAddress(eas) ? null : `returned ${actual}`;
  });

  await check("getSeedExecutor() returns the new executor and EAS", async () => {
    const [executor, executorEas] = await accountContract.getSeedExecutor();
    const problems = [];
    if (getAddress(executor) !== addresses.seedProtocolExecutor) problems.push(`executor ${executor}`);
    if (getAddress(executorEas) !== getAddress(eas)) problems.push(`EAS ${executorEas}`);
    return problems.length ? `returned ${problems.join(", ")}` : null;
  });

  for (const ext of [extensions.seedProtocolExtension, extensions.seedExecutorRouterExtension]) {
    for (const fn of ext.functions) {
      await check(`${fn.functionSignature.slice(0, fn.functionSignature.indexOf("("))} routes to ${ext.metadata.name}`, async () => {
        // Through the account: ManagedAccount asks its factory, so this covers both.
        const impl = getAddress(await accountContract.getImplementationForFunction(fn.functionSelector));
        return impl === ext.metadata.implementation ? null : `routes to ${impl}, expected ${ext.metadata.implementation}`;
      });
    }
  }

  console.log(failures.length ? `\n${failures.length} check(s) failed.` : "\nAll checks passed.");
  return failures;
}
