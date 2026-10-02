/**
 * Runs the rollout against a throwaway `hardhat node` (docs/deploy-plan.md, P6).
 *
 *   bun run rehearse:local       – LocalStack (a stand-in OP Sepolia) on a fresh node
 *   bun run rehearse:op-sepolia [--account <address> --admin <address>]
 *                                – the real OP Sepolia factory, on a forking node
 *
 * Each step is the same command the real rollout uses, so a green rehearsal means
 * the commands, parameters and scripts work end to end. Run with bun.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Interface } from "ethers";

const ROOT = path.resolve(import.meta.dirname, "..");
const RPC = "http://127.0.0.1:8545";
const NODE_LOG = path.join(ROOT, "cache", "rehearsal-node.log");

function hardhat(...args: string[]) {
  console.log(`\n$ hardhat ${args.join(" ")}`);
  // stdin answers Ignition's "Confirm deploy to network …?" on non-31337 chains (the fork).
  const result = spawnSync("npx", ["hardhat", ...args], { cwd: ROOT, stdio: ["pipe", "inherit", "inherit"], input: "y\n" });
  if (result.status !== 0) throw new Error(`hardhat ${args[0]} failed (exit ${result.status})`);
}

async function rpc(method: string, params: unknown[] = []) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return ((await res.json()) as { result: any }).result;
}

async function rpcUp(): Promise<boolean> {
  try {
    await rpc("eth_chainId");
    return true;
  } catch {
    return false;
  }
}

/** Starts `hardhat node` with `args`, logging to cache/rehearsal-node.log, and waits for it. */
async function startNode(args: string[]): Promise<ChildProcess> {
  if (await rpcUp()) throw new Error(`Something is already listening on ${RPC}; stop it first.`);
  mkdirSync(path.dirname(NODE_LOG), { recursive: true });
  const log = openSync(NODE_LOG, "w");
  console.log(`Starting hardhat node ${args.join(" ")} (log: ${path.relative(ROOT, NODE_LOG)})`);
  const node = spawn("npx", ["hardhat", "node", ...args], { cwd: ROOT, stdio: ["ignore", log, log] });
  for (let i = 0; i < 120; i++) {
    if (node.exitCode !== null) throw new Error(`hardhat node exited (${node.exitCode}); see ${NODE_LOG}`);
    if (await rpcUp()) return node;
    await new Promise((r) => setTimeout(r, 500));
  }
  node.kill();
  throw new Error(`hardhat node didn't come up; see ${NODE_LOG}`);
}

/** The factory's first account (BaseAccountFactory.getAccounts), or "" if it has none. */
async function firstAccount(factory: string): Promise<string> {
  const iface = new Interface(["function getAccounts(uint256 start, uint256 end) view returns (address[])"]);
  try {
    const result = await rpc("eth_call", [{ to: factory, data: iface.encodeFunctionData("getAccounts", [0, 1]) }, "latest"]);
    return iface.decodeFunctionResult("getAccounts", result)[0][0] ?? "";
  } catch {
    return "";
  }
}

function deployedAddresses(deploymentId: string): Record<string, string> {
  return JSON.parse(readFileSync(path.join(ROOT, "ignition/deployments", deploymentId, "deployed_addresses.json"), "utf8"));
}

async function rehearseLocal() {
  const deploymentId = "chain-31337";
  rmSync(path.join(ROOT, "ignition/deployments", deploymentId), { recursive: true, force: true });

  const node = await startNode([]);
  try {
    hardhat("ignition", "deploy", "ignition/modules/LocalStack.ts", "--network", "localhost");
    const stack = deployedAddresses(deploymentId);
    const account = stack["LocalStack#Account"];
    const [, accountAdmin] = await rpc("eth_accounts");

    // Same shape as ignition/parameters/optimism_sepolia.json; the addresses are
    // deterministic on a fresh node, so this only changes when LocalStack does.
    const parametersFile = "ignition/parameters/localhost.json";
    writeFileSync(
      path.join(ROOT, parametersFile),
      JSON.stringify(
        { SeedProtocol: { eas: stack["LocalStack#EAS"] }, SeedRollout: { factory: stack["LocalStack#ManagedAccountFactory"] } },
        null,
        2,
      ) + "\n",
    );

    hardhat(
      "ignition", "deploy", "ignition/modules/SeedProtocol.ts",
      "--network", "localhost", "--strategy", "create2", "--parameters", parametersFile,
    );
    hardhat("seed:extension-payload", "--network", "localhost");
    hardhat("seed:replace-extension", "--network", "localhost", "--dry-run");
    hardhat("seed:replace-extension", "--network", "localhost");
    hardhat("seed:replace-extension", "--network", "localhost", "--check-only");
    hardhat("seed:ensure-schemas", "--network", "localhost");
    hardhat("seed:verify-live", "--network", "localhost", "--account", account);
    hardhat("seed:publish-smoke", "--network", "localhost", "--account", account, "--impersonate-admin", accountAdmin);
    console.log("\nLocal rehearsal passed.");
  } finally {
    node.kill();
  }
}

/**
 * P6.2: the rollout against the real OP Sepolia factory on a forking node,
 * impersonating the EXTENSION_ROLE holder. `--account`/`--admin` (input I3) add
 * checks on an existing account; without them only a fresh one is used.
 *
 * Ignition won't deploy from an impersonated account, so the contracts come from a
 * node account and land on different CREATE2 addresses than the real deploy;
 * seed:predict-addresses checks the real ones. Routing and access control don't
 * depend on the address.
 */
async function rehearseOpSepolia(args: string[]) {
  const option = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? "" : args[i + 1];
  };
  const deploymentId = "op-sepolia-fork-rehearsal";
  const parametersFile = "ignition/parameters/optimism_sepolia.json";
  const parameters = JSON.parse(readFileSync(path.join(ROOT, parametersFile), "utf8"));
  if (!parameters.SeedRollout?.factory) {
    throw new Error(`${parametersFile} has no SeedRollout.factory yet (the ManagedAccountFactory address, input I1).`);
  }
  rmSync(path.join(ROOT, "ignition/deployments", deploymentId), { recursive: true, force: true });

  const node = await startNode(["--network", "optimism_sepolia_fork"]);
  try {
    const common = ["--network", "localhost", "--deployment-id", deploymentId];
    hardhat("seed:predict-addresses", "--network", "localhost", "--parameters", parametersFile);
    hardhat(
      "ignition", "deploy", "ignition/modules/SeedProtocol.ts", ...common,
      "--strategy", "create2", "--parameters", parametersFile,
    );
    const rollout = [...common, "--parameters", parametersFile];
    hardhat("seed:extension-payload", "--network", "localhost", "--deployment-id", deploymentId);
    hardhat("seed:replace-extension", ...rollout, "--dry-run");
    hardhat("seed:replace-extension", ...rollout, "--impersonate", "auto");
    hardhat("seed:replace-extension", ...rollout, "--check-only");
    hardhat("seed:ensure-schemas", "--network", "localhost", "--parameters", parametersFile);

    // Without --account, check an existing account of the factory (verify-live is read-only).
    const account = option("account") || (await firstAccount(parameters.SeedRollout.factory));
    const admin = option("admin");
    if (account) hardhat("seed:verify-live", ...rollout, "--account", account);
    hardhat(
      "seed:publish-smoke", "--network", "localhost", "--parameters", parametersFile,
      ...(account && admin ? ["--account", account, "--impersonate-admin", admin] : []),
    );
    console.log(`\nOP Sepolia fork rehearsal passed. Routing before: ignition/deployments/${deploymentId}/routing-before.json`);
    if (!option("account")) console.log(`No --account given: verify-live used the factory's first account, ${account}.`);
  } finally {
    node.kill();
  }
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "local") {
  await rehearseLocal();
} else if (mode === "op-sepolia") {
  await rehearseOpSepolia(rest);
} else {
  console.error("usage: bun scripts/rehearse.ts local | op-sepolia [--account <address> --admin <address>]");
  process.exit(2);
}
