/**
 * SeedProtocolExecutor on a real thirdweb ManagedAccount via SeedExecutorRouterExtension.
 * See docs/security/extension-access-control-plan.md (D5, D7, D8, step 8).
 *
 * Flow under test: signer → account.execute(executor, multiPublish) → executor →
 * account.executeFromExecutor → EAS, with the account as attester.
 */
import { expect } from "chai";
import { AbiCoder, type ContractTransactionReceipt, Interface, ZeroAddress, ZeroHash, parseEther, solidityPacked } from "ethers";
import { network } from "hardhat";
import {
  type ManagedAccountExecutorSetup,
  attestedEvents,
  buildPublishRequests,
  createManagedAccountFixtures,
  expectCustomError,
  expectUserOpRejected,
} from "./fixtures/managedAccountFixture.js";

const connection = await network.create();
const { ethers, networkHelpers } = connection;
const { loadFixture, impersonateAccount, setBalance } = networkHelpers;
const { managedAccountExecutorFixture, grantSessionKey, revokeSessionKey, sendUserOp } =
  createManagedAccountFixtures(connection);

type Setup = ManagedAccountExecutorSetup;

const MODULE_TYPE_EXECUTOR = 2n;
const SINGLE_MODE = ZeroHash;
const BATCH_MODE = "0x01" + "00".repeat(31);

async function installedExecutorFixture() {
  const setup = await managedAccountExecutorFixture();
  await (await setup.account.connect(setup.accountAdmin).installSeedExecutor()).wait();
  return setup;
}

function executeCallData(setup: Setup, target: string, value: bigint, data: string) {
  return setup.account.interface.encodeFunctionData("execute", [target, value, data]);
}

function executorMultiPublishCallData(setup: Setup, options?: Parameters<typeof buildPublishRequests>[1]) {
  return (setup.executor.interface as Interface).encodeFunctionData("multiPublish", [buildPublishRequests(setup, options)]);
}

/** account.execute(executor, value, multiPublish(...)) from the account admin's EOA. */
async function adminPublishViaExecutor(
  setup: Setup,
  { value = 0n, ...options }: { value?: bigint } & Parameters<typeof buildPublishRequests>[1] = {},
) {
  const executorAddress = await setup.executor.getAddress();
  return setup.account
    .connect(setup.accountAdmin)
    .execute(executorAddress, value, executorMultiPublishCallData(setup, options));
}

async function grantExecutorSessionKey(setup: Setup) {
  await grantSessionKey(setup.account, setup.accountAdmin, setup.delegate.address, {
    approvedTargets: [await setup.executor.getAddress()],
  });
}

/** A UserOp from the delegate: account.execute(executor, 0, data). */
async function delegateCallsExecutor(setup: Setup, data: string) {
  return sendUserOp({
    ...setup,
    signer: setup.delegate,
    callData: executeCallData(setup, await setup.executor.getAddress(), 0n, data),
  });
}

function seedAttestCallData(setup: Setup) {
  return setup.eas.interface.encodeFunctionData("attest", [
    {
      schema: setup.seedSchemaUid,
      data: {
        recipient: ZeroAddress,
        expirationTime: 0n,
        revocable: true,
        refUID: ZeroHash,
        data: AbiCoder.defaultAbiCoder().encode(["bytes32"], [setup.seedSchemaUid]),
        value: 0n,
      },
    },
  ]);
}

function packExecution(target: string, value: bigint, callData: string) {
  return solidityPacked(["address", "uint256", "bytes"], [target, value, callData]);
}

/** Signer for the executor contract's address, to probe executeFromExecutor directly. */
async function executorSigner(setup: Setup) {
  const address = await setup.executor.getAddress();
  await impersonateAccount(address);
  await setBalance(address, parseEther("10"));
  return ethers.getSigner(address);
}

function expectAttestedByAccount(setup: Setup, receipt: ContractTransactionReceipt | null, count: number) {
  const attested = attestedEvents(setup.eas, receipt);
  expect(attested).to.have.length(count);
  for (const { attester } of attested) expect(attester).to.equal(setup.accountAddress);
  return attested;
}

describe("SeedExecutorRouterExtension", function () {
  describe("install / uninstall", function () {
    it("lets an admin EOA install the executor with the extension's EAS", async function () {
      const setup = await loadFixture(managedAccountExecutorFixture);
      const executorAddress = await setup.executor.getAddress();
      expect(await setup.account.isModuleInstalled(MODULE_TYPE_EXECUTOR, executorAddress, "0x")).to.equal(false);

      await (await setup.account.connect(setup.accountAdmin).installSeedExecutor()).wait();

      expect(await setup.account.isModuleInstalled(MODULE_TYPE_EXECUTOR, executorAddress, "0x")).to.equal(true);
      expect(await setup.executor.isInitialized(setup.accountAddress)).to.equal(true);
      expect(await setup.executor.getEAS(setup.accountAddress)).to.equal(setup.easAddress);
      const [executor, eas] = await setup.account.getSeedExecutor();
      expect(executor).to.equal(executorAddress);
      expect(eas).to.equal(setup.easAddress);
    });

    it("lets an admin install through a UserOp that calls installSeedExecutor directly", async function () {
      const setup = await loadFixture(managedAccountExecutorFixture);
      const { success } = await sendUserOp({
        ...setup,
        signer: setup.accountAdmin,
        callData: setup.account.interface.encodeFunctionData("installSeedExecutor"),
      });
      expect(success).to.equal(true);
      expect(await setup.executor.isInitialized(setup.accountAddress)).to.equal(true);
    });

    it("rejects a stranger installing", async function () {
      const setup = await loadFixture(managedAccountExecutorFixture);
      const [caller] = await expectCustomError(
        setup.account.connect(setup.stranger).installSeedExecutor(),
        setup.account.interface,
        "Unauthorized",
      );
      expect(caller).to.equal(setup.stranger.address);
    });

    it("rejects a session key installing or uninstalling through a self-call", async function () {
      const setup = await loadFixture(managedAccountExecutorFixture);
      await grantSessionKey(setup.account, setup.accountAdmin, setup.delegate.address, {
        approvedTargets: [setup.accountAddress],
      });
      const viaSelf = (fn: string) =>
        sendUserOp({
          ...setup,
          signer: setup.delegate,
          callData: executeCallData(setup, setup.accountAddress, 0n, setup.account.interface.encodeFunctionData(fn)),
        });

      expect((await viaSelf("installSeedExecutor")).success).to.equal(false);
      expect(await setup.executor.isInitialized(setup.accountAddress)).to.equal(false);

      await (await setup.account.connect(setup.accountAdmin).installSeedExecutor()).wait();
      expect((await viaSelf("uninstallSeedExecutor")).success).to.equal(false);
      expect(await setup.executor.isInitialized(setup.accountAddress)).to.equal(true);
    });

    it("rejects installing twice", async function () {
      const setup = await loadFixture(installedExecutorFixture);
      await expectCustomError(
        setup.account.connect(setup.accountAdmin).installSeedExecutor(),
        setup.account.interface,
        "SeedExecutorAlreadyInstalled",
      );
    });

    it("uninstalls cleanly and can't uninstall twice", async function () {
      const setup = await loadFixture(installedExecutorFixture);
      const executorAddress = await setup.executor.getAddress();

      await (await setup.account.connect(setup.accountAdmin).uninstallSeedExecutor()).wait();

      expect(await setup.account.isModuleInstalled(MODULE_TYPE_EXECUTOR, executorAddress, "0x")).to.equal(false);
      expect(await setup.executor.isInitialized(setup.accountAddress)).to.equal(false);
      await expectCustomError(
        setup.account.connect(setup.accountAdmin).uninstallSeedExecutor(),
        setup.account.interface,
        "SeedExecutorNotInstalled",
      );
    });

    it("only reports the Seed executor as an installed executor module", async function () {
      const setup = await loadFixture(installedExecutorFixture);
      const executorAddress = await setup.executor.getAddress();
      expect(await setup.account.isModuleInstalled(1n, executorAddress, "0x")).to.equal(false);
      expect(await setup.account.isModuleInstalled(MODULE_TYPE_EXECUTOR, setup.stranger.address, "0x")).to.equal(false);
    });
  });

  describe("publishing through the executor", function () {
    it("admin publishes as the account, with everything revocable", async function () {
      const setup = await loadFixture(installedExecutorFixture);
      const receipt = await (await adminPublishViaExecutor(setup, { revocable: false })).wait();
      for (const { uid } of expectAttestedByAccount(setup, receipt, 3)) {
        expect((await setup.eas.getAttestation(uid)).revocable).to.equal(true);
      }
    });

    it("a delegate's session key scoped to the executor publishes as the account", async function () {
      const setup = await loadFixture(installedExecutorFixture);
      await grantExecutorSessionKey(setup);
      const { success, revertReason, receipt } = await delegateCallsExecutor(setup, executorMultiPublishCallData(setup));
      expect(success, `revertReason: ${revertReason}`).to.equal(true);
      expectAttestedByAccount(setup, receipt, 3);
    });

    it("stops the delegate as soon as the admin revokes its session key", async function () {
      const setup = await loadFixture(installedExecutorFixture);
      await grantExecutorSessionKey(setup);
      await revokeSessionKey(setup.account, setup.accountAdmin, setup.delegate.address);
      await expectUserOpRejected(
        delegateCallsExecutor(setup, executorMultiPublishCallData(setup)),
        setup.entryPoint,
        "AA24",
      );
    });

    it("stops working once the executor is uninstalled", async function () {
      const setup = await loadFixture(installedExecutorFixture);
      await (await setup.account.connect(setup.accountAdmin).uninstallSeedExecutor()).wait();
      await expectCustomError(adminPublishViaExecutor(setup), setup.executor.interface as Interface, "NotInitialized");
    });

    it("round-trips value without the account or executor losing any", async function () {
      const setup = await loadFixture(installedExecutorFixture);
      const value = parseEther("1");
      const executorAddress = await setup.executor.getAddress();
      const accountBefore = await ethers.provider.getBalance(setup.accountAddress);

      await (await adminPublishViaExecutor(setup, { value })).wait();

      expect(await ethers.provider.getBalance(executorAddress)).to.equal(0n);
      expect(await ethers.provider.getBalance(setup.accountAddress)).to.equal(accountBefore);
    });
  });

  describe("delegate can't reconfigure the executor", function () {
    it("onUninstall sent by a delegate through the account has no effect", async function () {
      const setup = await loadFixture(installedExecutorFixture);
      await grantExecutorSessionKey(setup);
      const { success } = await delegateCallsExecutor(
        setup,
        setup.executor.interface.encodeFunctionData("onUninstall", ["0x"]),
      );
      expect(success).to.equal(false);
      expect(await setup.executor.getEAS(setup.accountAddress)).to.equal(setup.easAddress);
    });

    it("onInstall sent by a delegate through the account has no effect", async function () {
      const setup = await loadFixture(installedExecutorFixture);
      await grantExecutorSessionKey(setup);
      const { success } = await delegateCallsExecutor(
        setup,
        setup.executor.interface.encodeFunctionData("onInstall", [
          AbiCoder.defaultAbiCoder().encode(["address"], [setup.delegate.address]),
        ]),
      );
      expect(success).to.equal(false);
      expect(await setup.executor.getEAS(setup.accountAddress)).to.equal(setup.easAddress);
    });
  });

  describe("executeFromExecutor restrictions", function () {
    it("rejects anyone but the installed executor, including the account admin", async function () {
      const setup = await loadFixture(installedExecutorFixture);
      const execution = packExecution(setup.easAddress, 0n, seedAttestCallData(setup));
      for (const caller of [setup.stranger, setup.accountAdmin]) {
        const [rejected] = await expectCustomError(
          setup.account.connect(caller).executeFromExecutor(SINGLE_MODE, execution),
          setup.account.interface,
          "NotSeedExecutor",
        );
        expect(rejected).to.equal(caller.address);
      }
    });

    it("rejects the executor when it isn't installed", async function () {
      const setup = await loadFixture(managedAccountExecutorFixture);
      const signer = await executorSigner(setup);
      await expectCustomError(
        setup.account
          .connect(signer)
          .executeFromExecutor(SINGLE_MODE, packExecution(setup.easAddress, 0n, seedAttestCallData(setup))),
        setup.account.interface,
        "NotSeedExecutor",
      );
    });

    it("allows the installed executor a single EAS attest, as the account", async function () {
      const setup = await loadFixture(installedExecutorFixture);
      const signer = await executorSigner(setup);
      const tx = await setup.account
        .connect(signer)
        .executeFromExecutor(SINGLE_MODE, packExecution(setup.easAddress, 0n, seedAttestCallData(setup)));
      expectAttestedByAccount(setup, await tx.wait(), 1);
    });

    it("rejects batch mode", async function () {
      const setup = await loadFixture(installedExecutorFixture);
      const signer = await executorSigner(setup);
      await expectCustomError(
        setup.account.connect(signer).executeFromExecutor(BATCH_MODE, "0x"),
        setup.account.interface,
        "UnsupportedExecutionMode",
      );
    });

    it("rejects any target other than EAS", async function () {
      const setup = await loadFixture(installedExecutorFixture);
      const signer = await executorSigner(setup);
      const [target] = await expectCustomError(
        setup.account
          .connect(signer)
          .executeFromExecutor(SINGLE_MODE, packExecution(setup.stranger.address, 0n, seedAttestCallData(setup))),
        setup.account.interface,
        "TargetNotAllowed",
      );
      expect(target).to.equal(setup.stranger.address);
    });

    it("rejects EAS functions other than attest/multiAttest, including revocation (D8)", async function () {
      const setup = await loadFixture(installedExecutorFixture);
      const signer = await executorSigner(setup);
      const revoke = setup.eas.interface.encodeFunctionData("revoke", [
        { schema: setup.seedSchemaUid, data: { uid: ZeroHash, value: 0n } },
      ]);
      const [selector] = await expectCustomError(
        setup.account.connect(signer).executeFromExecutor(SINGLE_MODE, packExecution(setup.easAddress, 0n, revoke)),
        setup.account.interface,
        "SelectorNotAllowed",
      );
      expect(selector).to.equal(setup.eas.interface.getFunction("revoke").selector);
    });

    it("rejects calldata too short to carry a selector", async function () {
      const setup = await loadFixture(installedExecutorFixture);
      const signer = await executorSigner(setup);
      await expectCustomError(
        setup.account.connect(signer).executeFromExecutor(SINGLE_MODE, packExecution(setup.easAddress, 0n, "0x")),
        setup.account.interface,
        "SelectorNotAllowed",
      );
    });

    it("rejects value the executor didn't send, so the account never pays for it", async function () {
      const setup = await loadFixture(installedExecutorFixture);
      const signer = await executorSigner(setup);
      const encoded = parseEther("1");
      const [encodedValue, sentValue] = await expectCustomError(
        setup.account
          .connect(signer)
          .executeFromExecutor(SINGLE_MODE, packExecution(setup.easAddress, encoded, seedAttestCallData(setup))),
        setup.account.interface,
        "ValueMismatch",
      );
      expect(encodedValue).to.equal(encoded);
      expect(sentValue).to.equal(0n);
    });
  });
});
