import {
  AbiCoder,
  type Contract,
  type ContractRunner,
  type TransactionReceipt,
  type ContractTransactionResponse,
  type Interface,
  type Provider,
  type Signer,
  ZeroAddress,
  ZeroHash,
  getBytes,
  hexlify,
  parseUnits,
  randomBytes,
} from "ethers";

/**
 * Driving a thirdweb ManagedAccount: session keys, ERC-4337 UserOperations and
 * Seed publish requests. Shared by the test fixtures and the rehearsal scripts
 * (docs/deploy-plan.md, steps 6–7).
 */

const MAX_UINT128 = (1n << 128n) - 1n;
const ONE_DAY = 24n * 60n * 60n;

/**
 * An ethers `Contract` whose methods come from a merged or runtime-chosen ABI.
 * Ethers types `connect()` as returning a bare `BaseContract`, which drops the
 * dynamic methods; this keeps them.
 */
// Our signature must come first: TypeScript picks the first matching overload of an intersection.
export type DynamicContract = { connect(runner: ContractRunner | null): DynamicContract } & Contract;

const SIGNER_PERMISSION_TYPES = {
  SignerPermissionRequest: [
    { name: "signer", type: "address" },
    { name: "isAdmin", type: "uint8" },
    { name: "approvedTargets", type: "address[]" },
    { name: "nativeTokenLimitPerTransaction", type: "uint256" },
    { name: "permissionStartTimestamp", type: "uint128" },
    { name: "permissionEndTimestamp", type: "uint128" },
    { name: "reqValidityStartTimestamp", type: "uint128" },
    { name: "reqValidityEndTimestamp", type: "uint128" },
    { name: "uid", type: "bytes32" },
  ],
};

export interface SignerPermissionRequest {
  signer: string;
  isAdmin?: number;
  approvedTargets?: string[];
  nativeTokenLimitPerTransaction?: bigint;
  permissionStartTimestamp?: bigint;
  permissionEndTimestamp?: bigint;
  reqValidityStartTimestamp?: bigint;
  reqValidityEndTimestamp?: bigint;
  uid?: string;
}


// ---------------------------------------------------------------------------
// EAS helpers
// ---------------------------------------------------------------------------

export interface AttestedEvent {
  recipient: string;
  attester: string;
  uid: string;
  schema: string;
}

/** Returns `{ uid, attester, recipient, schema }` for every Attested event in a receipt. */
export function attestedEvents(
  eas: { target: string | unknown; interface: Interface },
  receipt: TransactionReceipt | null,
): AttestedEvent[] {
  const easAddress = String(eas.target).toLowerCase();
  return (receipt?.logs ?? [])
    .filter((log) => log.address.toLowerCase() === easAddress)
    .map((log) => eas.interface.parseLog(log))
    .filter((parsed) => parsed?.name === "Attested")
    .map((parsed) => ({
      recipient: parsed!.args.recipient,
      attester: parsed!.args.attester,
      uid: parsed!.args.uid,
      schema: parsed!.args.schemaUID,
    }));
}

/**
 * One publish request: new seed + version, plus one property attestation whose
 * refUID the extension rewrites to the new version. With no propertiesToUpdate it
 * encodes for both the legacy (string localId) and V2 (publishIndex) ABIs.
 */
export function buildPublishRequests(
  setup: { seedSchemaUid: string; versionSchemaUid: string; propertySchemaUid: string },
  { revocable = true, propertyValue = "hello" }: { revocable?: boolean; propertyValue?: string } = {},
) {
  return [
    {
      localId: "request-1",
      seedUid: ZeroHash,
      seedSchemaUid: setup.seedSchemaUid,
      versionUid: ZeroHash,
      versionSchemaUid: setup.versionSchemaUid,
      seedIsRevocable: revocable,
      listOfAttestations: [
        {
          schema: setup.propertySchemaUid,
          data: [
            {
              recipient: ZeroAddress,
              expirationTime: 0n,
              revocable,
              refUID: ZeroHash,
              data: AbiCoder.defaultAbiCoder().encode(["string"], [propertyValue]),
              value: 0n,
            },
          ],
        },
      ],
      propertiesToUpdate: [] as unknown[],
    },
  ];
}


// ---------------------------------------------------------------------------
// Network-bound helpers
// ---------------------------------------------------------------------------

/** An EntryPoint v0.6 UserOperation. */
export interface UserOperation {
  sender: string;
  nonce: bigint;
  initCode: string;
  callData: string;
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  paymasterAndData: string;
  signature: string;
}

/** What `sendUserOp` needs from EntryPoint v0.6 (the TypeChain type or a plain Contract). */
export interface EntryPointLike {
  interface: Interface;
  getNonce(sender: string, key: number): Promise<bigint>;
  getUserOpHash(op: UserOperation): Promise<string>;
  connect(runner: Signer): { handleOps(ops: UserOperation[], beneficiary: string): Promise<ContractTransactionResponse> };
}

export function createAccountHelpers({ ethers }: { ethers: { provider: Provider } }) {
  async function latestTimestamp(): Promise<bigint> {
    const block = await ethers.provider.getBlock("latest");
    return BigInt(block!.timestamp);
  }

  /**
   * Signs and submits a SignerPermissionRequest. `admin` must be an account admin;
   * the request can be submitted by anyone, matching thirdweb's design.
   */
  async function setSignerPermissions(account: DynamicContract, admin: Signer, request: SignerPermissionRequest) {
    const { chainId } = await ethers.provider.getNetwork();
    const domain = { name: "Account", version: "1", chainId, verifyingContract: await account.getAddress() };
    const fullRequest = {
      isAdmin: 0,
      approvedTargets: [],
      nativeTokenLimitPerTransaction: 0n,
      permissionStartTimestamp: 0n,
      permissionEndTimestamp: 0n,
      reqValidityStartTimestamp: 0n,
      reqValidityEndTimestamp: MAX_UINT128,
      uid: hexlify(randomBytes(32)),
      ...request,
    };
    const signature = await admin.signTypedData(domain, SIGNER_PERMISSION_TYPES, fullRequest);
    const tx = await account.connect(admin).setPermissionsForSigner(fullRequest, signature);
    return tx.wait();
  }

  /** Grants a non-admin session key (e.g. a third-party publisher) scoped to `approvedTargets`. */
  async function grantSessionKey(
    account: DynamicContract,
    admin: Signer,
    signerAddress: string,
    { approvedTargets, nativeTokenLimit = 0n, duration = ONE_DAY }: { approvedTargets: string[]; nativeTokenLimit?: bigint; duration?: bigint },
  ) {
    const now = await latestTimestamp();
    return setSignerPermissions(account, admin, {
      signer: signerAddress,
      approvedTargets,
      nativeTokenLimitPerTransaction: nativeTokenLimit,
      permissionStartTimestamp: now - 1n,
      permissionEndTimestamp: now + duration,
    });
  }

  /** Revokes a session key: no targets and an expired window, so `isValidSigner` rejects it. */
  async function revokeSessionKey(account: DynamicContract, admin: Signer, signerAddress: string) {
    return setSignerPermissions(account, admin, { signer: signerAddress });
  }

  // -------------------------------------------------------------------------
  // ERC-4337 UserOperations (EntryPoint v0.6)
  // -------------------------------------------------------------------------

  /**
   * Signs `callData` as a UserOperation from `signer` and submits it via handleOps.
   * Validation failures make handleOps revert with `FailedOp`; execution failures
   * don't revert, so the result reports `success` and any `revertReason`.
   */
  async function sendUserOp({
    entryPoint,
    account,
    signer,
    callData,
    bundler,
    callGasLimit = 5_000_000n,
  }: {
    entryPoint: EntryPointLike;
    account: DynamicContract;
    signer: Signer;
    callData: string;
    bundler: Signer;
    callGasLimit?: bigint;
  }) {
    const sender = await account.getAddress();
    const block = await ethers.provider.getBlock("latest");
    const priorityFee = parseUnits("1", "gwei");

    const op: UserOperation = {
      sender,
      nonce: await entryPoint.getNonce(sender, 0),
      initCode: "0x",
      callData,
      callGasLimit,
      verificationGasLimit: 1_000_000n,
      preVerificationGas: 100_000n,
      maxFeePerGas: block!.baseFeePerGas! * 2n + priorityFee,
      maxPriorityFeePerGas: priorityFee,
      paymasterAndData: "0x",
      signature: "0x",
    };
    op.signature = await signer.signMessage(getBytes(await entryPoint.getUserOpHash(op)));

    const receipt = await (await entryPoint.connect(bundler).handleOps([op], await bundler.getAddress())).wait();

    let success = false;
    let revertReason: string | null = null;
    for (const log of receipt?.logs ?? []) {
      let parsed;
      try {
        parsed = entryPoint.interface.parseLog(log);
      } catch {
        continue;
      }
      if (parsed?.name === "UserOperationEvent") success = parsed.args.success;
      if (parsed?.name === "UserOperationRevertReason") revertReason = parsed.args.revertReason;
    }
    return { receipt, success, revertReason };
  }

  return { latestTimestamp, setSignerPermissions, grantSessionKey, revokeSessionKey, sendUserOp };
}
