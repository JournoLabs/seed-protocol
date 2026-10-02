import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Contract, Interface, getAddress, parseEther } from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import {
  EXTENSION_ROLE,
  type RouterAction,
  type RoutingSnapshot,
  describeAction,
  expectedRouting,
  planRollout,
  routingMismatches,
  takeSnapshot,
} from "./lib/routing.js";
import { isSimulated } from "./lib/network.js";
import { buildSeedExtensions, defaultDeploymentId, loadRolloutParameters, loadSeedAddresses } from "./lib/seedDeployment.js";

/**
 * `hardhat seed:replace-extension`: points the ManagedAccountFactory's Router at a
 * SeedProtocol deployment (docs/deploy-plan.md, P4 and step 4).
 *
 *   1. Snapshots the registry to ignition/deployments/<id>/routing-before.json (rollback record).
 *   2. replaceExtension(SeedProtocolExtension), dropping the old selectors (setEas included).
 *   3. addExtension(SeedExecutorRouterExtension).
 *   4. Reads the registry back and fails if any selector routes to the wrong place.
 *
 * Steps 2–3 go in one `multicall`, so they land together. If the signer can't
 * act for an EXTENSION_ROLE holder, the call is printed to submit by hand;
 * `--check-only` then runs step 4 on its own.
 */

const LEGACY_SET_EAS = new Interface(["function setEas(address)"]).getFunction("setEas")!.selector;

interface Args {
  parameters: string;
  deploymentId: string;
  metadataUri: string;
  dryRun: boolean;
  checkOnly: boolean;
  impersonate: string;
}

type Connection = Awaited<ReturnType<HardhatRuntimeEnvironment["network"]["getOrCreate"]>>;
export type SeedExtensions = Awaited<ReturnType<typeof buildSeedExtensions>>;

export default async function replaceExtensionTask(args: Args, hre: HardhatRuntimeEnvironment) {
  const connection = await hre.network.getOrCreate();
  const { chainId } = await connection.ethers.provider.getNetwork();
  const deploymentId = args.deploymentId || defaultDeploymentId(chainId);
  const parametersFile = args.parameters || `ignition/parameters/${connection.networkName}.json`;
  const { factory } = await loadRolloutParameters(hre, parametersFile);

  console.log(`Network ${connection.networkName} (chain ${chainId}), deployment ${deploymentId}`);
  await replaceExtension(connection, {
    factory: new Contract(factory, (await hre.artifacts.readArtifact("ManagedAccountFactory")).abi, connection.ethers.provider),
    extensions: await buildSeedExtensions(hre, await loadSeedAddresses(hre, deploymentId), args.metadataUri),
    snapshotFile: path.join(hre.config.paths.ignition, "deployments", deploymentId, "routing-before.json"),
    dryRun: args.dryRun,
    checkOnly: args.checkOnly,
    impersonate: args.impersonate,
  });
}

/** The task body, on an existing connection (tests call this directly). */
export async function replaceExtension(
  connection: Connection,
  {
    factory,
    extensions,
    snapshotFile,
    dryRun = false,
    checkOnly = false,
    impersonate = "",
  }: {
    factory: Contract;
    extensions: SeedExtensions;
    snapshotFile: string;
    dryRun?: boolean;
    checkOnly?: boolean;
    impersonate?: string;
  },
): Promise<{ sent: boolean }> {
  const factoryAddress = getAddress(factory.target as string);
  console.log(`Factory ${factoryAddress}`);
  if ((await connection.ethers.provider.getCode(factoryAddress)) === "0x") {
    throw new Error(`No contract at factory ${factoryAddress} on this network; check SeedRollout.factory (input I1).`);
  }

  if (checkOnly) {
    await check(factory, await readSnapshot(snapshotFile), extensions);
    return { sent: false };
  }

  const wantedSelectors = [extensions.seedProtocolExtension, extensions.seedExecutorRouterExtension].flatMap((e) =>
    e.functions.map((f) => f.functionSelector),
  );
  const before = await takeSnapshot(factory, [...wantedSelectors, LEGACY_SET_EAS]);
  console.log(`EXTENSION_ROLE holders: ${before.extensionRoleHolders.join(", ") || "(none)"}`);
  console.log(`Registered extensions at block ${before.blockNumber}:`);
  for (const ext of before.extensions) console.log(`  ${ext.name} → ${ext.implementation} (${ext.functions.length} functions)`);

  const actions = planRollout(before.extensions, extensions.seedProtocolExtension, extensions.seedExecutorRouterExtension);
  console.log("Planned changes:");
  for (const action of actions) console.log(`  ${describeAction(action)}`);

  const changes = actions.filter((a) => a.kind !== "unchanged");
  if (changes.length === 0) {
    console.log("Nothing to change.");
    await check(factory, existsSync(snapshotFile) ? await readSnapshot(snapshotFile) : before, extensions);
    return { sent: false };
  }
  const tx = { to: factoryAddress, data: encodeChanges(factory.interface, changes), value: 0n };

  if (dryRun) {
    printCall(tx, changes);
    console.log("Dry run: nothing written or sent.");
    return { sent: false };
  }

  await saveSnapshot(snapshotFile, before);

  if (impersonate === "auto") {
    if (!before.extensionRoleHolders.length) throw new Error("--impersonate auto: nobody holds EXTENSION_ROLE");
    impersonate = before.extensionRoleHolders[0];
  }
  const sender = await resolveSender(connection, impersonate);
  if (!(await factory.hasRole(EXTENSION_ROLE, sender.address))) {
    printCall(tx, changes);
    console.log(
      `${sender.address} doesn't hold EXTENSION_ROLE, so the call wasn't sent. ` +
        `Submit it from ${before.extensionRoleHolders.join(" or ")}, then run with --check-only.`,
    );
    process.exitCode = 1;
    return { sent: false };
  }

  console.log(`Sending from ${sender.address}…`);
  const receipt = await (await sender.sendTransaction(tx)).wait();
  console.log(`Mined in block ${receipt?.blockNumber} (tx ${receipt?.hash})`);

  await check(factory, await readSnapshot(snapshotFile), extensions);
  return { sent: true };
}

/** One call per change, wrapped in `multicall` when there's more than one. */
function encodeChanges(iface: Interface, changes: RouterAction[]): string {
  const calls = changes.map((a) =>
    iface.encodeFunctionData(a.kind === "add" ? "addExtension" : "replaceExtension", [a.extension]),
  );
  return calls.length === 1 ? calls[0] : iface.encodeFunctionData("multicall", [calls]);
}

function printCall(tx: { to: string; data: string; value: bigint }, changes: RouterAction[]) {
  console.log("\nCall for the EXTENSION_ROLE holder:");
  console.log(`  to:    ${tx.to}`);
  console.log(`  value: 0`);
  console.log(`  data:  ${tx.data}`);
  console.log("  which does:");
  for (const change of changes) console.log(`    ${describeAction(change)}`);
  console.log("  extension structs:");
  console.log(JSON.stringify(changes.map((c) => c.extension), null, 2).replace(/^/gm, "    "));
  console.log();
}

/**
 * The signer to send from. `--impersonate` only works on simulated networks
 * (the in-process network, `hardhat node`, or a fork).
 */
async function resolveSender(connection: Connection, impersonate: string) {
  const { ethers } = connection;
  if (impersonate) {
    if (!(await isSimulated(connection))) {
      throw new Error(`--impersonate only works on simulated networks, not ${connection.networkName}`);
    }
    const address = getAddress(impersonate);
    await ethers.provider.send("hardhat_impersonateAccount", [address]);
    await ethers.provider.send("hardhat_setBalance", [address, "0x" + parseEther("1").toString(16)]);
    return ethers.getSigner(address);
  }
  const [signer] = await ethers.getSigners();
  return signer;
}

async function saveSnapshot(file: string, snapshot: RoutingSnapshot) {
  if (existsSync(file)) {
    // Keep the first snapshot: it's the pre-rollout state, which is what a rollback restores.
    console.log(`Keeping existing ${path.relative(process.cwd(), file)}`);
    return;
  }
  await writeFile(file, JSON.stringify(snapshot, null, 2) + "\n");
  console.log(`Wrote ${path.relative(process.cwd(), file)}`);
}

async function readSnapshot(file: string): Promise<RoutingSnapshot> {
  if (!existsSync(file)) throw new Error(`No ${file}; run without --check-only first.`);
  return JSON.parse(await readFile(file, "utf8"));
}

/** Reads the registry back against what the rollout should have produced from `before`. */
async function check(
  factory: Contract,
  before: RoutingSnapshot,
  extensions: SeedExtensions,
) {
  const actions = planRollout(before.extensions, extensions.seedProtocolExtension, extensions.seedExecutorRouterExtension);
  const mismatches = await routingMismatches(factory, expectedRouting(before, actions));
  if (mismatches.length) {
    throw new Error(`Router doesn't match the rollout:\n  ${mismatches.join("\n  ")}`);
  }
  console.log(`Routing check passed (${Object.keys(before.routing).length} selectors from block ${before.blockNumber}).`);
}
