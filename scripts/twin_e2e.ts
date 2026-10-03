/**
 * `bun run twin:e2e [--sdk <path>]`: drives seed-protocol-sdk's own publish code against a
 * running twin (`bun run twin:up`), to check the SDK and the contracts agree before a rollout
 * (docs/local-twin-plan.md).
 *
 * The SDK is loaded from source (default ../seed-protocol-sdk). Only thirdweb's hosted in-app
 * login is replaced: a fresh local key is connected to the exact smart-account options the SDK
 * builds. Everything else (wallet config, encoders, transaction adapter, readiness checks,
 * session-key permissions) is the SDK's code, and every transaction goes through the twin's
 * bundler or node.
 *
 * It imports SDK internals by path (packages/publish/src/helpers/…), so an SDK refactor can
 * move them; the error names the missing module. Run with bun.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  AbiCoder,
  Contract,
  Interface,
  JsonRpcProvider,
  NonceManager,
  Wallet,
  ZeroAddress,
  ZeroHash,
  parseEther,
  toQuantity,
} from "ethers";
import { ROOT } from "./lib/orchestration.js";
import { schemaUid } from "./lib/schemas.js";

const args = process.argv.slice(2);
const sdkArg = args.indexOf("--sdk");
const sdkRoot = path.resolve(ROOT, sdkArg === -1 ? "../seed-protocol-sdk" : args[sdkArg + 1]);
const PUBLISH = path.join(sdkRoot, "packages/publish");
const TWIN_JSON = path.join(ROOT, ".twin/twin.json");

if (!existsSync(TWIN_JSON)) throw new Error("No .twin/twin.json: start the twin with `bun run twin:up`.");
if (!existsSync(path.join(PUBLISH, "src/config.ts"))) throw new Error(`No SDK publish package at ${PUBLISH} (pass --sdk <path>).`);
const twin = JSON.parse(readFileSync(TWIN_JSON, "utf8"));

/** An SDK module by its path under packages/publish/src. */
async function sdk(modulePath: string): Promise<any> {
  const file = path.join(PUBLISH, "src", `${modulePath}.ts`);
  if (!existsSync(file)) throw new Error(`SDK module ${modulePath} not found at ${file}; the SDK moved it, update scripts/twin_e2e.ts.`);
  return import(file);
}

/**
 * thirdweb as the SDK resolves it, so the smart wallet built here shares the SDK's module
 * instance (and its client). `Bun.resolveSync` uses the same resolver as the SDK's imports.
 */
async function sdkThirdweb(specifier: string): Promise<any> {
  return import((globalThis as any).Bun.resolveSync(specifier, PUBLISH));
}

const { initPublish } = await sdk("config");
const { seedTwinConfig } = await sdk("helpers/seedTwin");
const { getManagedAccountWallet, getModularAccountWallet, getClient, deployManagedAccountViaFactory } = await sdk("helpers/thirdweb");
const { getPublishThirdwebChain } = await sdk("helpers/thirdwebChain");
const { fromThirdwebAccount } = await sdk("helpers/adapters/thirdwebAccount");
const C = await sdk("helpers/contracts/index");
const { ensureManagedAccountEasConfigured } = await sdk("helpers/ensureManagedAccountEasConfigured");
const { assertExecutorModuleReadyForAccount, simulateCallFromAccount } = await sdk("helpers/executorModuleReadiness");
const { buildAutomationSessionKeyPermissions, toThirdwebSessionKeyPermissions } = await sdk("helpers/automationSessionKeyPermissions");
const { isAutomationSessionActive } = await sdk("helpers/ensureAutomationSessionKey");
const { privateKeyToAccount, smartWallet } = await sdkThirdweb("thirdweb/wallets");
const { addSessionKey } = await sdkThirdweb("thirdweb/extensions/erc4337");
const { getContract, sendTransaction } = await sdkThirdweb("thirdweb");

// ---------------------------------------------------------------------------------------------

const results: { ok: boolean; line: string }[] = [];
async function step(label: string, fn: () => Promise<string | void>) {
  try {
    const note = await fn();
    results.push({ ok: true, line: `ok    ${label}${note ? ` — ${note}` : ""}` });
  } catch (e) {
    results.push({ ok: false, line: `FAIL  ${label} — ${(e as Error).message.split("\n")[0]}` });
  }
  console.log(results.at(-1)!.line);
  if (!results.at(-1)!.ok) finish(); // later steps depend on earlier ones
}
function finish(): never {
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
}

const provider = new JsonRpcProvider(twin.rpcUrl);
const fund = (address: string, eth = "10") => provider.send("hardhat_setBalance", [address, toQuantity(parseEther(eth))]);
const artifactAbi = (file: string) => new Interface(JSON.parse(readFileSync(path.join(ROOT, "artifacts", file), "utf8")).abi);
const extensionAbi = artifactAbi("contracts/SeedProtocolExtension.sol/SeedProtocolExtension.json");
const eas = new Contract(twin.contracts.eas, artifactAbi(
  "@ethereum-attestation-service/eas-contracts/contracts/EAS.sol/EAS.json"), provider);

initPublish({
  ...seedTwinConfig(twin).publish,
  uploadApiBaseUrl: "http://127.0.0.1:1", // unused: no uploads here
  thirdwebClientId: "seed-twin-e2e", // unused: no hosted thirdweb calls on the twin
  useModularExecutor: true,
});
const client = getClient();

// Schemas for the publishes. "author_ref" is a property that holds another seed's UID.
const SCHEMAS = {
  author: "bytes32 twin_e2e_author",
  post: "bytes32 twin_e2e_post",
  title: "string twin_e2e_title",
  authorRef: "bytes32 twin_e2e_author_ref",
};
const uid = (s: string) => schemaUid(s) as `0x${string}`;

/**
 * Two requests in one batch: an author, and a post whose `author_ref` property gets the
 * author's new seed UID (`propertiesToUpdate`, the cross-reference the contracts harden).
 */
function batch(title: string, authorTarget = "post") {
  const property = (schema: string, data: string) => ({
    schema: uid(schema),
    data: [{ recipient: ZeroAddress, expirationTime: 0n, revocable: true, refUID: ZeroHash, data, value: 0n }],
  });
  const string = (v: string) => AbiCoder.defaultAbiCoder().encode(["string"], [v]);
  const common = { seedUid: ZeroHash, versionUid: ZeroHash, versionSchemaUid: twin.baseSchemas.version, seedIsRevocable: true };
  return [
    {
      ...common,
      localId: "author",
      seedSchemaUid: uid(SCHEMAS.author),
      listOfAttestations: [property(SCHEMAS.title, string(`${title} author`))],
      propertiesToUpdate: [{ publishLocalId: authorTarget, propertySchemaUid: uid(SCHEMAS.authorRef) }],
    },
    {
      ...common,
      localId: "post",
      seedSchemaUid: uid(SCHEMAS.post),
      listOfAttestations: [property(SCHEMAS.title, string(`${title} post`)), property(SCHEMAS.authorRef, ZeroHash)],
      propertiesToUpdate: [],
    },
  ];
}

/** Checks a batch's attestations: 7, all by `account`, and the post's author_ref holds the author seed UID. */
async function checkBatch(transactionHash: string, account: string): Promise<string[]> {
  const receipt = await provider.getTransactionReceipt(transactionHash);
  if (receipt?.status !== 1) throw new Error(`tx ${transactionHash} reverted`);
  const attested = receipt.logs
    .filter((l) => l.address.toLowerCase() === twin.contracts.eas.toLowerCase())
    .map((l) => eas.interface.parseLog(l))
    .filter((e) => e?.name === "Attested")
    .map((e) => e!.args);
  if (attested.length !== 7) throw new Error(`${attested.length} attestations, expected 7`);
  const stranger = attested.find((a) => a.attester.toLowerCase() !== account.toLowerCase());
  if (stranger) throw new Error(`attested by ${stranger.attester}, expected ${account}`);
  const authorSeed = attested.find((a) => a.schemaUID === uid(SCHEMAS.author))!.uid;
  const ref = attested.find((a) => a.schemaUID === uid(SCHEMAS.authorRef))!.uid;
  const refData = (await eas.getAttestation(ref)).data;
  if (refData !== AbiCoder.defaultAbiCoder().encode(["bytes32"], [authorSeed])) throw new Error("the post's author_ref doesn't hold the author's seed UID");
  return attested.map((a) => a.uid);
}

// ---------------------------------------------------------------------------------------------

console.log(`SDK ${sdkRoot}\nTwin ${twin.rpcUrl} (chain ${twin.chainId}), bundler ${twin.bundlerUrl}\n`);

let smartOptions: any;
await step("SDK config for the twin: managed wallet is EIP-4337 on chain 31337, twin RPC, factory and bundler, no sponsorship; admin wallet is a plain EOA", async () => {
  const managed = getManagedAccountWallet().getConfig();
  smartOptions = managed.executionMode?.smartAccount;
  const problems: string[] = [];
  if (managed.executionMode?.mode !== "EIP4337") problems.push(`managed mode ${managed.executionMode?.mode}`);
  if (smartOptions?.chain?.id !== twin.chainId || getPublishThirdwebChain().id !== twin.chainId) problems.push(`chain ${smartOptions?.chain?.id}`);
  if (smartOptions?.chain?.rpc !== twin.rpcUrl) problems.push(`rpc ${smartOptions?.chain?.rpc}`);
  if (smartOptions?.factoryAddress?.toLowerCase() !== twin.contracts.managedAccountFactory.toLowerCase()) problems.push(`factory ${smartOptions?.factoryAddress}`);
  if (smartOptions?.sponsorGas !== false) problems.push(`sponsorGas ${smartOptions?.sponsorGas}`);
  if (smartOptions?.overrides?.bundlerUrl !== twin.bundlerUrl) problems.push(`bundler ${smartOptions?.overrides?.bundlerUrl}`);
  const admin = getModularAccountWallet().getConfig();
  if (admin.executionMode?.mode !== "EOA") problems.push(`admin wallet mode ${admin.executionMode?.mode}`);
  if (problems.length) throw new Error(problems.join(", "));
});

// Fresh keys every run: the in-app EOA stand-in (the account's admin), a schema registrar,
// and later an automation session key.
const adminEoa = privateKeyToAccount({ client, privateKey: Wallet.createRandom().privateKey });
const registrar = new NonceManager(new Wallet(Wallet.createRandom().privateKey, provider));
await fund(adminEoa.address);
await fund(await registrar.getAddress());
const managed = await smartWallet(smartOptions).connect({ client, personalAccount: adminEoa });
await fund(managed.address); // no paymaster on the twin: the account pays for its UserOps
console.log(`      account ${managed.address}, admin ${adminEoa.address}`);

const registry = new Contract(twin.contracts.schemaRegistry, artifactAbi(
  "@ethereum-attestation-service/eas-contracts/contracts/SchemaRegistry.sol/SchemaRegistry.json"), registrar);
for (const s of Object.values(SCHEMAS)) {
  if ((await registry.getSchema(uid(s))).uid === ZeroHash) await (await registry.register(s, ZeroAddress, true)).wait();
}

let interactiveUids: string[] = [];
/**
 * The pre-send check createAttestations runs on the interactive route before sending. The flow
 * only reaches it with a deployed account (an eth_call to an address with no code passes
 * anything), so this refuses to run it on one.
 */
async function presendCheck(tx: unknown) {
  if ((await provider.getCode(managed.address)) === "0x") throw new Error("pre-send check on an undeployed account");
  await simulateCallFromAccount({
    managedAddress: fromThirdwebAccount(managed).txSender.address,
    tx,
    action: "multiPublish",
    code: "PUBLISH_PREFLIGHT_FAILED",
    requireSimulation: false,
  });
}

await step("the SDK deploys the account from the admin EOA before publishing (deployManagedAccountViaFactory, as the modular publish prep does)", async () => {
  await deployManagedAccountViaFactory({ adminAddress: adminEoa.address, signingAccount: adminEoa });
  if ((await provider.getCode(managed.address)) === "0x") throw new Error(`no code at ${managed.address}`);
});

await step("interactive publish with a cross-reference: account → multiPublish on itself (SDK encodeMultiPublish + pre-send check + fromThirdwebAccount; a UserOp through the twin bundler)", async () => {
  const tx = C.encodeMultiPublish(managed.address, batch("interactive"), 5_000_000n);
  await presendCheck(tx);
  const { transactionHash } = await fromThirdwebAccount(managed).txSender.sendTransaction(tx);
  interactiveUids = await checkBatch(transactionHash, managed.address);
  return "7 attestations by the account; author_ref set";
});

await step("ensureManagedAccountEasConfigured: the account reports the twin's EAS, nothing sent", async () => {
  let asked = false;
  await ensureManagedAccountEasConfigured(managed.address, async () => {
    asked = true;
    throw new Error("asked for a sender");
  });
  if (asked) throw new Error("wanted to send setEas");
});

await step("the extension rejects a cross-reference to an unknown publishLocalId (UnknownPublishLocalId)", async () => {
  const tx = C.encodeMultiPublish(managed.address, batch("bad", "no-such-request"), 5_000_000n);
  try {
    await provider.send("eth_call", [{ from: adminEoa.address, to: tx.to, data: tx.data }, "latest"]);
  } catch (e: any) {
    const data = [e.data, e.info?.error?.data, e.error?.data].find((d) => typeof d === "string" && d.startsWith("0x"));
    const name = data ? extensionAbi.parseError(data)?.name : undefined;
    if (name === "UnknownPublishLocalId") return;
    throw new Error(`reverted with ${name ?? data ?? e.message}`);
  }
  throw new Error("succeeded");
});

await step("the SDK's pre-send check passes a valid publish on the deployed account and rejects the unknown publishLocalId (PUBLISH_PREFLIGHT_FAILED)", async () => {
  await presendCheck(C.encodeMultiPublish(managed.address, batch("presend"), 5_000_000n));
  try {
    await presendCheck(C.encodeMultiPublish(managed.address, batch("bad", "no-such-request"), 5_000_000n));
  } catch (e: any) {
    if (e.code === "PUBLISH_PREFLIGHT_FAILED" && /UnknownPublishLocalId/.test(e.message)) return "valid batch passes; bad batch names UnknownPublishLocalId";
    throw new Error(`rejected with ${e.code ?? ""} ${e.message}`);
  }
  throw new Error("the bad batch passed the check");
});

await step("readiness check fails before installSeedExecutor", async () => {
  try {
    await assertExecutorModuleReadyForAccount(managed.address);
  } catch {
    return;
  }
  throw new Error("passed before install");
});

await step("installSeedExecutor from the admin EOA (SDK encodeInstallSeedExecutor, EOA mode)", async () => {
  const { transactionHash } = await fromThirdwebAccount(adminEoa).txSender.sendTransaction(C.encodeInstallSeedExecutor(managed.address));
  if ((await provider.getTransactionReceipt(transactionHash))?.status !== 1) throw new Error("reverted");
  if (!(await C.readSeedExecutorInstalled(managed.address, twin.contracts.seedProtocolExecutor))) throw new Error("not installed");
});

await step("readiness check passes after install", async () => {
  await assertExecutorModuleReadyForAccount(managed.address);
});

const sessionKey = privateKeyToAccount({ client, privateKey: Wallet.createRandom().privateKey });
const sessionSmartAccount = () =>
  smartWallet({ ...smartOptions, overrides: { ...smartOptions.overrides, accountAddress: managed.address } })
    .connect({ client, personalAccount: sessionKey });

await step("automation session key granted with the SDK's permissions: the executor only", async () => {
  const permissions = toThirdwebSessionKeyPermissions(buildAutomationSessionKeyPermissions({ expiresAt: Math.floor(Date.now() / 1000) + 3600 }));
  const targets = permissions.approvedTargets.map((t: string) => t.toLowerCase());
  if (targets.length !== 1 || targets[0] !== twin.contracts.seedProtocolExecutor.toLowerCase()) throw new Error(`approvedTargets ${targets}`);
  const contract = getContract({ client, chain: getPublishThirdwebChain(), address: managed.address });
  await sendTransaction({ account: managed, transaction: addSessionKey({ contract, account: managed, sessionKeyAddress: sessionKey.address, permissions }) });
  if (!(await isAutomationSessionActive(managed.address, sessionKey.address))) throw new Error("isAutomationSessionActive is false");
});

await step("automation publish with a cross-reference: session key → executor.multiPublish (SDK encodeExecutorMultiPublish, simulated first)", async () => {
  const tx = C.encodeExecutorMultiPublish(twin.contracts.seedProtocolExecutor, batch("automation"), 5_000_000n);
  await simulateCallFromAccount({ managedAddress: managed.address, tx, action: "multiPublish via the executor module" });
  const { transactionHash } = await fromThirdwebAccount(await sessionSmartAccount()).txSender.sendTransaction(tx);
  await checkBatch(transactionHash, managed.address);
  return "7 attestations by the account; author_ref set via publishIndex";
});

await step("the session key can't publish on the account directly", async () => {
  try {
    await fromThirdwebAccount(await sessionSmartAccount()).txSender.sendTransaction(
      C.encodeMultiPublish(managed.address, batch("refused"), 5_000_000n));
  } catch {
    return;
  }
  throw new Error("went through");
});

await step("owner revokes the interactive batch through EAS (SDK encodeEasMultiRevoke, from the account)", async () => {
  const bySchema = new Map<string, string[]>();
  for (const id of interactiveUids) {
    const { schema } = await eas.getAttestation(id);
    bySchema.set(schema, [...(bySchema.get(schema) ?? []), id]);
  }
  const requests = [...bySchema].map(([schema, ids]) => ({ schema, data: ids.map((id) => ({ uid: id, value: 0n })) }));
  await fromThirdwebAccount(managed).txSender.sendTransaction(C.encodeEasMultiRevoke(requests));
  for (const id of interactiveUids) if ((await eas.getAttestation(id)).revocationTime === 0n) throw new Error(`${id} not revoked`);
  return `${interactiveUids.length} revoked`;
});

if (twin.easGraphqlUrl) {
  await step("the twin's EAS indexer has both batches and the revocations", async () => {
    for (let i = 0; i < 30; i++) {
      const res = await fetch(twin.easGraphqlUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: `{ attestations(where: { attester: { equals: "${managed.address}" } }) { id revoked } }` }),
      });
      const rows = ((await res.json()) as any).data.attestations as { revoked: boolean }[];
      const revoked = rows.filter((a) => a.revoked).length;
      if (rows.length >= 14 && revoked >= 7) return `${rows.length} attestations, ${revoked} revoked`;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("not indexed within 30 s");
  });
}

finish();
