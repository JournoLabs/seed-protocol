/**
 * Runs the rollout against a throwaway `hardhat node` (docs/deploy-plan.md, P6).
 *
 *   bun run rehearse:local       – LocalStack (a stand-in OP Sepolia) on a fresh node
 *
 * Each step is the same command the real rollout uses, so a green rehearsal means
 * the commands, parameters and scripts work end to end. Run with bun.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const RPC = "http://127.0.0.1:8545";
const NODE_LOG = path.join(ROOT, "cache", "rehearsal-node.log");

function hardhat(...args: string[]) {
  console.log(`\n$ hardhat ${args.join(" ")}`);
  const result = spawnSync("npx", ["hardhat", ...args], { cwd: ROOT, stdio: "inherit" });
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
    hardhat("seed:verify-live", "--network", "localhost", "--account", account);
    hardhat("seed:publish-smoke", "--network", "localhost", "--account", account, "--impersonate-admin", accountAdmin);
    console.log("\nLocal rehearsal passed.");
  } finally {
    node.kill();
  }
}

const mode = process.argv[2];
if (mode === "local") {
  await rehearseLocal();
} else {
  console.error("usage: bun scripts/rehearse.ts local");
  process.exit(2);
}
