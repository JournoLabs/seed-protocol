import type { HardhatEthers } from "@nomicfoundation/hardhat-ethers/types";
import { Contract, Interface, type Result, parseEther } from "ethers";
import {
  EXECUTOR_ROUTER_FUNCTIONS,
  SEED_EXTENSION_FUNCTIONS,
  buildExtension,
  mergeInterfaces,
} from "../../scripts/lib/extensions.js";
import { type DynamicContract, createAccountHelpers } from "../../scripts/lib/managedAccount.js";
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
 *
 * Session-key, UserOp and publish-request helpers live in scripts/lib/managedAccount.ts
 * (the rehearsals use them too) and are re-exported here.
 */

export {
  type AttestedEvent,
  type DynamicContract,
  type SignerPermissionRequest,
  attestedEvents,
  buildPublishRequests,
} from "../../scripts/lib/managedAccount.js";

interface SeedExtensionConfig {
  name: string;
  contractName: "SeedProtocolExtension";
  constructorArgs: (setup: { easAddress: string }) => [string];
  functions: string[];
}

/** SeedProtocolExtension as it should be registered on the factory (EAS pinned at construction). */
export const SEED_EXTENSION: SeedExtensionConfig = {
  name: "SeedProtocolExtension",
  contractName: "SeedProtocolExtension",
  constructorArgs: ({ easAddress }) => [easAddress],
  functions: SEED_EXTENSION_FUNCTIONS,
};

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
// Network-bound helpers and fixtures
// ---------------------------------------------------------------------------

export function createManagedAccountFixtures({ ethers }: { ethers: HardhatEthers }) {
  const { setSignerPermissions, grantSessionKey, revokeSessionKey, sendUserOp } = createAccountHelpers({ ethers });


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
    seedExtension = SEED_EXTENSION,
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

  /** Default fixture: a single account with the Seed extension registered. */
  async function managedAccountFixture() {
    return deployManagedAccountStack();
  }

  /** Default stack plus SeedProtocolExecutor and its Router extension (not yet installed on the account). */
  async function managedAccountExecutorFixture() {
    const setup = await deployManagedAccountStack({ withExecutor: true });
    return { ...setup, executor: setup.executor!, executorRouterImpl: setup.executorRouterImpl! };
  }

  return {
    deployManagedAccountStack,
    managedAccountFixture,
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
