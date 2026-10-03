import { Interface, type Log, type LogDescription, type Provider, type TransactionReceipt, formatEther, getBytes, toBeHex } from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import { mergeInterfaces } from "./lib/extensions.js";

/**
 * `hardhat seed:explain-userop --tx <hash>`: explains why a UserOp in an EntryPoint v0.6
 * `handleOps` transaction failed. thirdweb only reports "UserOp failed at txHash" when the
 * EntryPoint logged no revert reason, which is what running out of gas looks like. Read-only.
 *
 * For each UserOp in the bundle:
 *   - a logged revert reason is decoded with the Seed, account, executor and EAS errors;
 *   - otherwise the account call is replayed with `eth_call` (from the EntryPoint, at the block
 *     before) with plenty of gas. If it succeeds there, the UserOp ran out of gas, and the
 *     task prints how much it needed against its `callGasLimit`. If it reverts, the reason is
 *     decoded.
 *
 * The replay is exact when the transaction was first in its block (the usual case on the twin);
 * otherwise earlier transactions in the block may have changed the state, and the task says so.
 */

interface Args {
  tx: string;
}

/** Generous, but under the 2^24 per-transaction gas cap (EIP-7825) that newer chains enforce. */
const REPLAY_GAS = 16_000_000n;

export type UserOpOutcome =
  | { kind: "succeeded" }
  | { kind: "not-executed" }
  | { kind: "reverted"; reason: string; replayed: boolean }
  | { kind: "out-of-gas"; needed: bigint }
  | { kind: "state-dependent"; needed: bigint };

export interface UserOpExplanation {
  sender: string;
  nonce: bigint;
  call: string;
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  gasUsed?: bigint;
  gasCost?: bigint;
  outcome: UserOpOutcome;
}

export interface BundleExplanation {
  from: string;
  blockNumber: number;
  index: number;
  ops: UserOpExplanation[];
}

/**
 * Explains each UserOp in the handleOps transaction `txHash`. `entryPoint` is EntryPoint v0.6's
 * interface; `calls` holds every function and error the account's calls can reach.
 */
export async function explainUserOps(
  provider: Provider,
  { entryPoint, calls }: { entryPoint: Interface; calls: Interface },
  txHash: string,
): Promise<BundleExplanation> {
  const [tx, receipt] = await Promise.all([provider.getTransaction(txHash), provider.getTransactionReceipt(txHash)]);
  if (!tx || !receipt) throw new Error(`No mined transaction ${txHash} on this network`);
  const handleOps = entryPoint.getFunction("handleOps")!;
  if (tx.data.slice(0, 10) !== handleOps.selector) {
    throw new Error(`${txHash} isn't an EntryPoint v0.6 handleOps call (to ${tx.to})`);
  }

  const [ops] = entryPoint.decodeFunctionData(handleOps, tx.data);
  const events = parseEntryPointLogs(entryPoint, receipt);
  const before = receipt.blockNumber - 1;

  const explanations: UserOpExplanation[] = [];
  for (const op of ops) {
    const base = {
      sender: op.sender as string,
      nonce: op.nonce as bigint,
      call: describeCall(calls, op.callData),
      callGasLimit: op.callGasLimit as bigint,
      verificationGasLimit: op.verificationGasLimit as bigint,
      preVerificationGas: op.preVerificationGas as bigint,
    };
    const event = events.ops.find((e) => sameAddress(e.args.sender, base.sender) && e.args.nonce === base.nonce);
    if (!event) {
      explanations.push({ ...base, outcome: { kind: "not-executed" } });
      continue;
    }
    const withGas = { ...base, gasUsed: event.args.actualGasUsed as bigint, gasCost: event.args.actualGasCost as bigint };
    explanations.push({ ...withGas, outcome: await explainFailure(provider, calls, events, event, tx.to!, op.callData, base.callGasLimit, before) });
  }
  return { from: tx.from, blockNumber: receipt.blockNumber, index: receipt.index, ops: explanations };
}

async function explainFailure(
  provider: Provider,
  calls: Interface,
  events: ReturnType<typeof parseEntryPointLogs>,
  event: LogDescription,
  entryPoint: string,
  callData: string,
  callGasLimit: bigint,
  before: number,
): Promise<UserOpOutcome> {
  if (event.args.success) return { kind: "succeeded" };

  const logged = events.reverts.find((e) => e.args.userOpHash === event.args.userOpHash);
  if (logged) return { kind: "reverted", reason: describeRevert(calls, logged.args.revertReason), replayed: false };

  // No logged reason: the call ran out of gas or reverted without data. Replay it to tell which.
  const call = { from: entryPoint, to: event.args.sender as string, data: callData, blockTag: before };
  try {
    await provider.call({ ...call, gasLimit: REPLAY_GAS });
  } catch (e: any) {
    return { kind: "reverted", reason: describeRevert(calls, revertData(e)), replayed: true };
  }
  // eth_estimateGas includes the intrinsic cost; the EntryPoint gives the call exactly callGasLimit.
  const needed = (await provider.estimateGas(call)) - intrinsicGas(callData);
  return needed > callGasLimit ? { kind: "out-of-gas", needed } : { kind: "state-dependent", needed };
}

export default async function explainUserOpTask(args: Args, hre: HardhatRuntimeEnvironment) {
  if (!args.tx) throw new Error("--tx is required");
  const { ethers } = await hre.network.getOrCreate();
  const abi = async (name: string) => new Interface((await hre.artifacts.readArtifact(name)).abi);
  const calls = mergeInterfaces(
    await abi("ManagedAccount"),
    await abi("AccountExtension"),
    await abi("SeedProtocolExtension"),
    await abi("SeedProtocolExecutor"),
    await abi("SeedExecutorRouterExtension"),
    await abi("EAS"),
  );

  const bundle = await explainUserOps(ethers.provider, { entryPoint: await abi("EntryPoint"), calls }, args.tx);
  const before = bundle.blockNumber - 1;
  console.log(`handleOps by ${bundle.from} in block ${bundle.blockNumber} (index ${bundle.index}), ${bundle.ops.length} UserOp(s)`);
  if (bundle.index > 0) {
    console.log(`Note: not first in its block, so replays at block ${before} may miss state from earlier transactions.`);
  }

  for (const op of bundle.ops) {
    console.log(`\nUserOp from ${op.sender}, nonce ${toBeHex(op.nonce)}`);
    console.log(`  Call: ${op.call}`);
    console.log(`  Gas limits: call ${op.callGasLimit}, verification ${op.verificationGasLimit}, preVerification ${op.preVerificationGas}`);
    if (op.gasUsed !== undefined) console.log(`  Gas used: ${op.gasUsed} (cost ${formatEther(op.gasCost!)} ETH)`);

    const { outcome } = op;
    if (outcome.kind !== "succeeded") process.exitCode = 1;
    switch (outcome.kind) {
      case "succeeded":
        console.log("  Succeeded.");
        break;
      case "not-executed":
        console.log("  Not executed: no UserOperationEvent for it (it failed validation, or the bundle reverted).");
        break;
      case "reverted":
        console.log(
          outcome.replayed
            ? `  Failed with no logged reason; the replay at block ${before} reverts with ${outcome.reason}`
            : `  Failed: reverted with ${outcome.reason}`,
        );
        break;
      case "out-of-gas":
        console.log(`  Failed: ran out of gas. The replay at block ${before} succeeds with more gas.`);
        console.log(
          `  The call needs about ${outcome.needed} gas; the UserOp allowed ${op.callGasLimit}, ${outcome.needed - op.callGasLimit} short.`,
        );
        console.log("  The bundler's callGasLimit estimate was too low (thirdweb adds 50,000 to it).");
        break;
      case "state-dependent":
        console.log(`  Failed with no reason, but the replay at block ${before} succeeds within its gas limit (needs ${outcome.needed}).`);
        console.log("  The failure depended on state at the time: an earlier transaction in the block, or a later block.");
        break;
    }
  }
}

function parseEntryPointLogs(entryPoint: Interface, receipt: TransactionReceipt) {
  const parsed = receipt.logs.map((log: Log) => {
    try {
      return entryPoint.parseLog(log);
    } catch {
      return null;
    }
  });
  return {
    ops: parsed.filter((p) => p?.name === "UserOperationEvent").map((p) => p!),
    reverts: parsed.filter((p) => p?.name === "UserOperationRevertReason").map((p) => p!),
  };
}

/** "execute → 0xTarget.multiPublish" for the account's execute/executeBatch, or the function name. */
function describeCall(calls: Interface, data: string): string {
  const name = (inner: string) => calls.getFunction(inner.slice(0, 10))?.name ?? inner.slice(0, 10);
  try {
    const parsed = calls.parseTransaction({ data });
    if (parsed?.name === "execute") return `execute → ${parsed.args[0]}.${name(parsed.args[2])}`;
    if (parsed?.name === "executeBatch") {
      return `executeBatch → ${parsed.args[0].map((t: string, i: number) => `${t}.${name(parsed.args[2][i])}`).join(", ")}`;
    }
    if (parsed) return parsed.name;
  } catch {
    // fall through
  }
  return data.slice(0, 10);
}

function describeRevert(calls: Interface, data: string | undefined): string {
  if (!data || data === "0x") return "no data";
  try {
    const parsed = calls.parseError(data);
    if (parsed) return `${parsed.signature} ${JSON.stringify(parsed.args.toArray(), (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`;
  } catch {
    // not an error we know
  }
  return `data ${data}`;
}

function revertData(e: any): string | undefined {
  return e.data ?? e.info?.error?.data ?? e.error?.data;
}

function intrinsicGas(data: string): bigint {
  return getBytes(data).reduce((sum, b) => sum + (b ? 16n : 4n), 21_000n);
}

function sameAddress(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}
