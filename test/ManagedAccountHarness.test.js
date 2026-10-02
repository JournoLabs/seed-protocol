/**
 * Exercises SeedProtocolExtension through a real thirdweb ManagedAccount
 * (fallback → Router → delegatecall), and pins down the delegated-publishing
 * behaviour that the access-control fix must preserve:
 *   - account admins can publish
 *   - a third party holding a session key can publish as the account
 *   - the admin can revoke that session key at any time
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const {
  managedAccountFixture,
  grantSessionKey,
  revokeSessionKey,
  sendUserOp,
  expectUserOpRejected,
  attestedEvents,
  buildLegacyPublishRequests,
} = require("./fixtures/managedAccountFixture");

async function readyFixture() {
  const setup = await loadFixture(managedAccountFixture);
  // The currently deployed extension keeps EAS in account storage, so it must be set first.
  await (await setup.account.connect(setup.accountAdmin).setEas(setup.easAddress)).wait();
  return setup;
}

function multiPublishCallData(setup) {
  return setup.account.interface.encodeFunctionData("multiPublish", [buildLegacyPublishRequests(setup)]);
}

/** `account.execute(account, 0, multiPublish(...))` – the self-call path session keys use. */
function executeSelfMultiPublishCallData(setup) {
  return setup.account.interface.encodeFunctionData("execute", [
    setup.accountAddress,
    0n,
    multiPublishCallData(setup),
  ]);
}

function expectAllAttestedBy(setup, receipt, expectedCount) {
  const attested = attestedEvents(setup.eas, receipt);
  expect(attested).to.have.length(expectedCount);
  for (const event of attested) {
    expect(event.attester).to.equal(setup.accountAddress);
  }
}

describe("ManagedAccount harness", function () {
  describe("wiring", function () {
    it("routes Seed selectors on the factory to the extension implementation", async function () {
      const setup = await loadFixture(managedAccountFixture);
      const selector = setup.account.interface.getFunction("multiPublish").selector;
      expect(await setup.factory.getImplementationForFunction(selector)).to.equal(await setup.seedImpl.getAddress());
    });

    it("makes accountAdmin the only admin", async function () {
      const { account, accountAdmin, delegate, stranger } = await loadFixture(managedAccountFixture);
      expect(await account.isAdmin(accountAdmin.address)).to.equal(true);
      expect(await account.isAdmin(delegate.address)).to.equal(false);
      expect(await account.isAdmin(stranger.address)).to.equal(false);
    });

    it("stores EAS in account storage, not the implementation's", async function () {
      const setup = await readyFixture();
      expect(await setup.account.getEas()).to.equal(setup.easAddress);
      expect(await setup.seedImpl.getEas()).to.equal(ethers.ZeroAddress);
    });
  });

  describe("admin publishing", function () {
    it("admin EOA calling the account directly publishes as the account", async function () {
      const setup = await readyFixture();
      const tx = await setup.account.connect(setup.accountAdmin).multiPublish(buildLegacyPublishRequests(setup));
      // seed + version + one property
      expectAllAttestedBy(setup, await tx.wait(), 3);
    });

    it("admin UserOp via execute(account, multiPublish) publishes as the account", async function () {
      const setup = await readyFixture();
      const { success, revertReason, receipt } = await sendUserOp({
        ...setup,
        signer: setup.accountAdmin,
        callData: executeSelfMultiPublishCallData(setup),
      });
      expect(success, `revertReason: ${revertReason}`).to.equal(true);
      expectAllAttestedBy(setup, receipt, 3);
    });

    it("admin UserOp calling multiPublish directly publishes as the account", async function () {
      const setup = await readyFixture();
      const { success, revertReason, receipt } = await sendUserOp({
        ...setup,
        signer: setup.accountAdmin,
        callData: multiPublishCallData(setup),
      });
      expect(success, `revertReason: ${revertReason}`).to.equal(true);
      expectAllAttestedBy(setup, receipt, 3);
    });
  });

  describe("delegated publishing via session key", function () {
    it("a session key approved for the account publishes as the account", async function () {
      const setup = await readyFixture();
      await grantSessionKey(setup.account, setup.accountAdmin, setup.delegate.address, {
        approvedTargets: [setup.accountAddress],
      });
      expect(await setup.account.isActiveSigner(setup.delegate.address)).to.equal(true);

      const { success, revertReason, receipt } = await sendUserOp({
        ...setup,
        signer: setup.delegate,
        callData: executeSelfMultiPublishCallData(setup),
      });
      expect(success, `revertReason: ${revertReason}`).to.equal(true);
      expectAllAttestedBy(setup, receipt, 3);
    });

    it("rejects a session key whose approved targets exclude the account", async function () {
      const setup = await readyFixture();
      await grantSessionKey(setup.account, setup.accountAdmin, setup.delegate.address, {
        approvedTargets: [setup.easAddress],
      });
      await expectUserOpRejected(
        sendUserOp({ ...setup, signer: setup.delegate, callData: executeSelfMultiPublishCallData(setup) }),
        setup.entryPoint,
        "AA24",
      );
    });

    it("rejects a session key calling multiPublish directly (only execute/executeBatch allowed)", async function () {
      const setup = await readyFixture();
      await grantSessionKey(setup.account, setup.accountAdmin, setup.delegate.address, {
        approvedTargets: [setup.accountAddress],
      });
      await expectUserOpRejected(
        sendUserOp({ ...setup, signer: setup.delegate, callData: multiPublishCallData(setup) }),
        setup.entryPoint,
        "AA24",
      );
    });

    it("stops working as soon as the admin revokes it", async function () {
      const setup = await readyFixture();
      await grantSessionKey(setup.account, setup.accountAdmin, setup.delegate.address, {
        approvedTargets: [setup.accountAddress],
      });
      const first = await sendUserOp({ ...setup, signer: setup.delegate, callData: executeSelfMultiPublishCallData(setup) });
      expect(first.success).to.equal(true);

      await revokeSessionKey(setup.account, setup.accountAdmin, setup.delegate.address);
      expect(await setup.account.isActiveSigner(setup.delegate.address)).to.equal(false);

      await expectUserOpRejected(
        sendUserOp({ ...setup, signer: setup.delegate, callData: executeSelfMultiPublishCallData(setup) }),
        setup.entryPoint,
        "AA24",
      );
    });

    it("stops working once its permission window expires", async function () {
      const setup = await readyFixture();
      await grantSessionKey(setup.account, setup.accountAdmin, setup.delegate.address, {
        approvedTargets: [setup.accountAddress],
        duration: 60n,
      });
      await time.increase(120);
      await expectUserOpRejected(
        sendUserOp({ ...setup, signer: setup.delegate, callData: executeSelfMultiPublishCallData(setup) }),
        setup.entryPoint,
        "AA24",
      );
    });

    it("rejects a non-admin key granting itself permissions", async function () {
      const setup = await readyFixture();
      // A delegate can't sign its own permission request – only admin signatures count.
      await expect(
        grantSessionKey(setup.account, setup.delegate, setup.delegate.address, {
          approvedTargets: [setup.accountAddress],
        }),
      ).to.be.revertedWith("!sig");
    });
  });
});
