/**
 * Driving a `hardhat node` and Hardhat commands from a script: shared by the
 * rehearsals (scripts/rehearse.ts) and the local twin (scripts/twin.ts). Run with bun.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { Interface } from "ethers";

export const ROOT = path.resolve(import.meta.dirname, "..", "..");
export const RPC = "http://127.0.0.1:8545";

export function hardhat(...args: string[]) {
  console.log(`\n$ hardhat ${args.join(" ")}`);
  // stdin answers Ignition's "Confirm deploy to network …?" on chains other than 31337.
  const result = spawnSync("npx", ["hardhat", ...args], { cwd: ROOT, stdio: ["pipe", "inherit", "inherit"], input: "y\n" });
  if (result.status !== 0) throw new Error(`hardhat ${args[0]} failed (exit ${result.status})`);
}

export async function rpc(method: string, params: unknown[] = [], url = RPC) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return ((await res.json()) as { result: any }).result;
}

export async function rpcUp(url = RPC): Promise<boolean> {
  try {
    await rpc("eth_chainId", [], url);
    return true;
  } catch {
    return false;
  }
}

/** Waits until `url` answers JSON-RPC, failing early if `child` exits. */
export async function waitForRpc(url: string, child: ChildProcess, name: string, logFile: string) {
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`${name} exited (${child.exitCode}); see ${logFile}`);
    if (await rpcUp(url)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error(`${name} didn't come up; see ${logFile}`);
}

/** Spawns `command` with its output in cache/<log>, returning the child and the log path. */
export function spawnLogged(command: string, args: string[], log: string, env: Record<string, string> = {}) {
  const logFile = path.join(ROOT, "cache", log);
  mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = openSync(logFile, "w");
  const child = spawn(command, args, { cwd: ROOT, stdio: ["ignore", fd, fd], env: { ...process.env, ...env } });
  return { child, logFile: path.relative(ROOT, logFile) };
}

/** Starts `hardhat node` with `args` and waits for it. */
export async function startNode(args: string[], { log, env = {} }: { log: string; env?: Record<string, string> }): Promise<ChildProcess> {
  if (await rpcUp()) throw new Error(`Something is already listening on ${RPC}; stop it first.`);
  const { child, logFile } = spawnLogged("npx", ["hardhat", "node", ...args], log, env);
  console.log(`Starting hardhat node ${args.join(" ")} (log: ${logFile})`);
  await waitForRpc(RPC, child, "hardhat node", logFile);
  return child;
}

/** The factory's first account (BaseAccountFactory.getAccounts), or "" if it has none. */
export async function firstAccount(factory: string): Promise<string> {
  const iface = new Interface(["function getAccounts(uint256 start, uint256 end) view returns (address[])"]);
  try {
    const result = await rpc("eth_call", [{ to: factory, data: iface.encodeFunctionData("getAccounts", [0, 1]) }, "latest"]);
    return iface.decodeFunctionResult("getAccounts", result)[0][0] ?? "";
  } catch {
    return "";
  }
}

export function deployedAddresses(deploymentId: string): Record<string, string> {
  return JSON.parse(readFileSync(path.join(ROOT, "ignition/deployments", deploymentId, "deployed_addresses.json"), "utf8"));
}
