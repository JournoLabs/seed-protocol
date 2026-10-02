import { type Contract, type JsonRpcProvider, type Wallet, concat, getBytes, toQuantity } from "ethers";
import type { UserOperation } from "./managedAccount.js";

/**
 * A minimal ERC-4337 (EntryPoint v0.6) client for a real bundler, the way thirdweb's
 * smart wallet uses one with a custom `bundlerUrl`: standard `eth_*UserOperation*`
 * methods, gas prices from the bundler. Used by `twin:up` to prove the twin's bundler
 * path without the SDK (docs/local-twin-plan.md).
 */

export interface BundlerUserOpResult {
  userOpHash: string;
  success: boolean;
  transactionHash: string;
  sender: string;
}

async function bundlerRpc<T>(bundlerUrl: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(bundlerUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string; data?: unknown } };
  if (body.error) throw new Error(`${method}: ${body.error.message}${body.error.data ? ` ${JSON.stringify(body.error.data)}` : ""}`);
  return body.result as T;
}

function toRpc(op: UserOperation) {
  const q = (v: bigint) => toQuantity(v);
  return {
    ...op,
    nonce: q(op.nonce),
    callGasLimit: q(op.callGasLimit),
    verificationGasLimit: q(op.verificationGasLimit),
    preVerificationGas: q(op.preVerificationGas),
    maxFeePerGas: q(op.maxFeePerGas),
    maxPriorityFeePerGas: q(op.maxPriorityFeePerGas),
  };
}

/**
 * Sends `callData` from `admin`'s ManagedAccount on `factory` (deploying it in the same
 * UserOp if needed) through the bundler, and waits for the receipt.
 */
export async function sendUserOpViaBundler({
  bundlerUrl,
  provider,
  entryPoint,
  factory,
  admin,
  accountSalt = "0x",
  callData,
}: {
  bundlerUrl: string;
  provider: JsonRpcProvider;
  entryPoint: Contract;
  factory: Contract;
  admin: Wallet;
  accountSalt?: string;
  callData: (sender: string) => string;
}): Promise<BundlerUserOpResult> {
  // Not factory.getAddress(): that's ethers' own method; the factory's takes (admin, data).
  const sender: string = await factory.getFunction("getAddress")(admin.address, accountSalt);
  const deployed = (await provider.getCode(sender)) !== "0x";
  const initCode = deployed
    ? "0x"
    : concat([factory.target as string, factory.interface.encodeFunctionData("createAccount", [admin.address, accountSalt])]);

  const { fast } = await bundlerRpc<{ fast: { maxFeePerGas: string; maxPriorityFeePerGas: string } }>(
    bundlerUrl,
    "pimlico_getUserOperationGasPrice",
    [],
  );
  const op: UserOperation = {
    sender,
    nonce: await entryPoint.getNonce(sender, 0),
    initCode,
    callData: callData(sender),
    // Placeholders for estimation; replaced by the bundler's numbers below.
    callGasLimit: 2_000_000n,
    verificationGasLimit: 2_000_000n,
    preVerificationGas: 1_000_000n,
    maxFeePerGas: BigInt(fast.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(fast.maxPriorityFeePerGas),
    paymasterAndData: "0x",
    signature: "0x",
  };
  const sign = async () => {
    op.signature = await admin.signMessage(getBytes(await entryPoint.getUserOpHash(op)));
  };

  await sign();
  const estimate = await bundlerRpc<Record<"preVerificationGas" | "verificationGasLimit" | "callGasLimit", string>>(
    bundlerUrl,
    "eth_estimateUserOperationGas",
    [toRpc(op), entryPoint.target],
  );
  op.preVerificationGas = BigInt(estimate.preVerificationGas);
  op.verificationGasLimit = BigInt(estimate.verificationGasLimit);
  op.callGasLimit = BigInt(estimate.callGasLimit);
  await sign();

  const userOpHash = await bundlerRpc<string>(bundlerUrl, "eth_sendUserOperation", [toRpc(op), entryPoint.target]);
  for (let i = 0; i < 60; i++) {
    const receipt = await bundlerRpc<{ success: boolean; receipt: { transactionHash: string } } | null>(
      bundlerUrl,
      "eth_getUserOperationReceipt",
      [userOpHash],
    );
    if (receipt) return { userOpHash, success: receipt.success, transactionHash: receipt.receipt.transactionHash, sender };
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`No receipt for UserOp ${userOpHash} after 30s`);
}
