import type { HardhatEthers, HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";
import {
  AbiCoder,
  Contract,
  type ContractRunner,
  type ContractTransactionReceipt,
  Interface,
  type Result,
  ZeroAddress,
  ZeroHash,
  getBytes,
  hexlify,
  parseEther,
  parseUnits,
  randomBytes,
} from "ethers";
import {
  EXECUTOR_ROUTER_FUNCTIONS,
  SEED_EXTENSION_FUNCTIONS,
  buildExtension,
  mergeInterfaces,
} from "../../scripts/lib/extensions.js";
import { deployEASWithSchemas } from "./easFixture.js";

/**
 * Real thirdweb ManagedAccount stack for exercising Seed extensions the way they
 * run on-chain: account fallback → Router → delegatecall into the extension.
 *
 * The older fixtures call the extension contract directly, which can't observe
 * delegatecall context (msg.sender, account storage, admin checks). Use this one
 * for anything that touches access control.
 *
 * Helpers that need a network (deploying, signing, sending UserOps) come from
 * `createManagedAccountFixtures(connection)`; call it once per test file so
 * `loadFixture` sees the same fixture functions each time. Everything else is a
 * plain export.
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

interface SeedExtensionConfig {
  name: string;
  contractName: "SeedProtocolExtension" | "SeedProtocolExtensionV2";
  constructorArgs: (setup: { easAddress: string }) => unknown[];
  functions: string[];
}

/** SeedProtocolExtension as it should be registered on the factory (EAS pinned at construction). */
export const SEED_EXTENSION_LEGACY: SeedExtensionConfig = {
  name: "SeedProtocolExtension",
  contractName: "SeedProtocolExtension",
  constructorArgs: ({ easAddress }) => [easAddress],
  functions: SEED_EXTENSION_FUNCTIONS,
};

/** SeedProtocolExtensionV2 (uint publishIndex cross-references), registered the same way. */
export const SEED_EXTENSION_V2: SeedExtensionConfig = {
  name: "SeedProtocolExtensionV2",
  contractName: "SeedProtocolExtensionV2",
  constructorArgs: ({ easAddress }) => [easAddress],
  functions: SEED_EXTENSION_FUNCTIONS,
};

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
// Router helpers
// ---------------------------------------------------------------------------

/** All function names in an interface (used to route the whole AccountExtension). */
function allFunctionNames(iface: Interface): string[] {
  return iface.fragments.filter((f) => f.type === "function").map((f) => f.format("sighash"));
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

/**
 * Awaits `promise`, expects it to revert with custom error `errorName` from `iface`,
 * and returns the decoded error args.
 *
 * Unlike chai's `revertedWithCustomError`, this hands back the args so tests can
 * assert on them, and it accepts any interface (e.g. the merged account ABI).
 */
export async function expectCustomError(promise: Promise<unknown>, iface: Interface, errorName: string): Promise<Result> {
  let error: any;
  try {
    await promise;
  } catch (e) {
    error = e;
  }
  if (!error) throw new Error(`expected revert with ${errorName}, but the call succeeded`);

  const data = error.data ?? error.error?.data ?? error.info?.error?.data;
  let parsed = null;
  try {
    parsed = data ? iface.parseError(data) : null;
  } catch {
    // not an error declared on iface
  }
  if (parsed?.name !== errorName) throw error;
  return parsed.args;
}

/**
 * Asserts a UserOperation was rejected during validation with an EntryPoint
 * `FailedOp` whose reason starts with `reasonPrefix` (e.g. "AA24" = bad signature
 * / signer not permitted, "AA22" = expired or not yet valid).
 */
export async function expectUserOpRejected(
  promise: Promise<unknown>,
  entryPoint: { interface: Interface },
  reasonPrefix: string,
): Promise<string> {
  const { reason } = await expectCustomError(promise, entryPoint.interface, "FailedOp");
  if (!reason.startsWith(reasonPrefix)) {
    throw new Error(`expected FailedOp reason starting with "${reasonPrefix}", got "${reason}"`);
  }
  return reason;
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
  receipt: ContractTransactionReceipt | null,
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
// Network-bound helpers and fixtures
// ---------------------------------------------------------------------------

export function createManagedAccountFixtures({ ethers }: { ethers: HardhatEthers }) {
  async function latestTimestamp(): Promise<bigint> {
    const block = await ethers.provider.getBlock("latest");
    return BigInt(block!.timestamp);
  }

  /**
   * Signs and submits a SignerPermissionRequest. `admin` must be an account admin;
   * the request can be submitted by anyone, matching thirdweb's design.
   */
  async function setSignerPermissions(account: DynamicContract, admin: HardhatEthersSigner, request: SignerPermissionRequest) {
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
    admin: HardhatEthersSigner,
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
  async function revokeSessionKey(account: DynamicContract, admin: HardhatEthersSigner, signerAddress: string) {
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
  }: {
    entryPoint: ManagedAccountSetup["entryPoint"];
    account: DynamicContract;
    signer: HardhatEthersSigner;
    callData: string;
    bundler: HardhatEthersSigner;
  }) {
    const sender = await account.getAddress();
    const block = await ethers.provider.getBlock("latest");
    const priorityFee = parseUnits("1", "gwei");

    const op = {
      sender,
      nonce: await entryPoint.getNonce(sender, 0),
      initCode: "0x",
      callData,
      callGasLimit: 5_000_000n,
      verificationGasLimit: 1_000_000n,
      preVerificationGas: 100_000n,
      maxFeePerGas: block!.baseFeePerGas! * 2n + priorityFee,
      maxPriorityFeePerGas: priorityFee,
      paymasterAndData: "0x",
      signature: "0x",
    };
    op.signature = await signer.signMessage(getBytes(await entryPoint.getUserOpHash(op)));

    const receipt = await (await entryPoint.connect(bundler).handleOps([op], bundler.address)).wait();

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

  // -------------------------------------------------------------------------
  // Fixture
  // -------------------------------------------------------------------------

  /**
   * Deploys EAS, EntryPoint, a ManagedAccountFactory with AccountExtension as its
   * default extension, registers `seedExtension` on the factory, and creates one
   * account owned by `accountAdmin`.
   *
   * Roles:
   *   factoryAdmin – holds EXTENSION_ROLE on the factory
   *   accountAdmin – the account's owner
   *   delegate     – third party a session key is granted to
   *   stranger     – unrelated address with no permissions
   *   bundler      – submits UserOperations
   */
  async function deployManagedAccountStack({
    seedExtension = SEED_EXTENSION_LEGACY,
    withExecutor = false,
  }: { seedExtension?: SeedExtensionConfig; withExecutor?: boolean } = {}) {
    const [factoryAdmin, accountAdmin, delegate, stranger, bundler] = await ethers.getSigners();

    const easSetup = await deployEASWithSchemas(ethers);
    const easAddress = await easSetup.eas.getAddress();

    const entryPoint = await ethers.deployContract("EntryPoint");
    await entryPoint.waitForDeployment();

    const accountExtension = await ethers.deployContract("AccountExtension");
    await accountExtension.waitForDeployment();

    const factory = await ethers.deployContract("ManagedAccountFactory", [
      factoryAdmin.address,
      await entryPoint.getAddress(),
      [
        buildExtension(
          "AccountExtension",
          await accountExtension.getAddress(),
          accountExtension.interface,
          allFunctionNames(accountExtension.interface),
        ),
      ],
    ]);
    await factory.waitForDeployment();

    // Plain (non-proxy) deploy of the Seed extension, registered on the factory.
    const SeedExtension = await ethers.getContractFactory(seedExtension.contractName);
    const seedImpl = (await SeedExtension.deploy(...seedExtension.constructorArgs({ easAddress }))) as unknown as DynamicContract;
    await seedImpl.waitForDeployment();
    await (
      await factory
        .connect(factoryAdmin)
        .addExtension(
          buildExtension(seedExtension.name, await seedImpl.getAddress(), SeedExtension.interface, seedExtension.functions),
        )
    ).wait();

    // Optionally: the ERC-7579 executor module plus the Router extension that lets accounts use it.
    let executor = null;
    let executorRouterImpl = null;
    if (withExecutor) {
      executor = await ethers.deployContract("SeedProtocolExecutor");
      await executor.waitForDeployment();

      executorRouterImpl = await ethers.deployContract("SeedExecutorRouterExtension", [easAddress, await executor.getAddress()]);
      await executorRouterImpl.waitForDeployment();
      await (
        await factory
          .connect(factoryAdmin)
          .addExtension(
            buildExtension(
              "SeedExecutorRouterExtension",
              await executorRouterImpl.getAddress(),
              executorRouterImpl.interface,
              EXECUTOR_ROUTER_FUNCTIONS,
            ),
          )
      ).wait();
    }

    // Create the account and fund it so it can prefund UserOperations.
    const accountAddress = await factory.createAccount.staticCall(accountAdmin.address, "0x");
    await (await factory.createAccount(accountAdmin.address, "0x")).wait();
    await (await factoryAdmin.sendTransaction({ to: accountAddress, value: parseEther("10") })).wait();

    const ManagedAccount = await ethers.getContractFactory("ManagedAccount");
    const accountInterface = mergeInterfaces(
      ManagedAccount.interface,
      accountExtension.interface,
      SeedExtension.interface,
      ...(executorRouterImpl ? [executorRouterImpl.interface] : []),
    );
    const account = new Contract(accountAddress, accountInterface, accountAdmin) as DynamicContract;

    return {
      ...easSetup,
      easAddress,
      entryPoint,
      factory,
      accountExtension,
      seedImpl,
      executor,
      executorRouterImpl,
      account,
      accountAddress,
      factoryAdmin,
      accountAdmin,
      delegate,
      stranger,
      bundler,
    };
  }

  /** Default fixture: a single account with the legacy Seed extension registered. */
  async function managedAccountFixture() {
    return deployManagedAccountStack();
  }

  /** Same stack with SeedProtocolExtensionV2 registered instead. */
  async function managedAccountV2Fixture() {
    return deployManagedAccountStack({ seedExtension: SEED_EXTENSION_V2 });
  }

  /** Legacy stack plus SeedProtocolExecutor and its Router extension (not yet installed on the account). */
  async function managedAccountExecutorFixture() {
    const setup = await deployManagedAccountStack({ withExecutor: true });
    return { ...setup, executor: setup.executor!, executorRouterImpl: setup.executorRouterImpl! };
  }

  return {
    deployManagedAccountStack,
    managedAccountFixture,
    managedAccountV2Fixture,
    managedAccountExecutorFixture,
    setSignerPermissions,
    grantSessionKey,
    revokeSessionKey,
    sendUserOp,
  };
}

type Fixtures = ReturnType<typeof createManagedAccountFixtures>;
export type ManagedAccountSetup = Awaited<ReturnType<Fixtures["deployManagedAccountStack"]>>;
export type ManagedAccountExecutorSetup = Awaited<ReturnType<Fixtures["managedAccountExecutorFixture"]>>;
