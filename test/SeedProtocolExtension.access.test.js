/**
 * Access control for SeedProtocolExtension when routed through a thirdweb
 * ManagedAccount. See docs/security/extension-access-control-plan.md (F1, F2, D1, D2, D7).
 *
 * Allowed publishing paths (admin EOA, admin UserOp, session-key UserOp) are
 * covered in ManagedAccountHarness.test.js; this file covers what must be refused.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const {
  managedAccountFixture,
  grantSessionKey,
  revokeSessionKey,
  sendUserOp,
  expectCustomError,
  attestedEvents,
  buildLegacyPublishRequests,
} = require("./fixtures/managedAccountFixture");

const LEGACY_SET_EAS = new ethers.Interface(["function setEas(address _eas) payable returns (string)"]);

function revokeCallData(eas, schema, uid) {
  return eas.interface.encodeFunctionData("revoke", [{ schema, data: { uid, value: 0n } }]);
}

describe("SeedProtocolExtension access control", function () {
  describe("F1: multiPublish", function () {
    it("rejects a stranger", async function () {
      const setup = await loadFixture(managedAccountFixture);
      const [caller] = await expectCustomError(
        setup.account.connect(setup.stranger).multiPublish(buildLegacyPublishRequests(setup)),
        setup.account.interface,
        "Unauthorized",
      );
      expect(caller).to.equal(setup.stranger.address);
    });

    it("rejects a session-key holder calling the account directly instead of through a UserOp", async function () {
      const setup = await loadFixture(managedAccountFixture);
      await grantSessionKey(setup.account, setup.accountAdmin, setup.delegate.address, {
        approvedTargets: [setup.accountAddress],
      });
      const [caller] = await expectCustomError(
        setup.account.connect(setup.delegate).multiPublish(buildLegacyPublishRequests(setup)),
        setup.account.interface,
        "Unauthorized",
      );
      expect(caller).to.equal(setup.delegate.address);
    });

    it("rejects a stranger going through execute", async function () {
      const setup = await loadFixture(managedAccountFixture);
      const inner = setup.account.interface.encodeFunctionData("multiPublish", [buildLegacyPublishRequests(setup)]);
      await expect(
        setup.account.connect(setup.stranger).execute(setup.accountAddress, 0n, inner),
      ).to.be.revertedWith("Account: not admin or EntryPoint.");
    });

    it("can't be used by calling the implementation directly", async function () {
      const setup = await loadFixture(managedAccountFixture);
      await expect(
        setup.seedImpl.connect(setup.stranger).multiPublish(buildLegacyPublishRequests(setup)),
      ).to.be.reverted;
    });
  });

  describe("F2 / D1: setEas", function () {
    it("is not routed on the account", async function () {
      const setup = await loadFixture(managedAccountFixture);
      await expect(
        setup.stranger.sendTransaction({
          to: setup.accountAddress,
          data: LEGACY_SET_EAS.encodeFunctionData("setEas", [setup.stranger.address]),
        }),
      ).to.be.revertedWith("Router: function does not exist.");
      expect(await setup.account.getEas()).to.equal(setup.easAddress);
    });

    it("can't be reached by a publishing session key either", async function () {
      const setup = await loadFixture(managedAccountFixture);
      await grantSessionKey(setup.account, setup.accountAdmin, setup.delegate.address, {
        approvedTargets: [setup.accountAddress],
      });
      const { success } = await sendUserOp({
        ...setup,
        signer: setup.delegate,
        callData: setup.account.interface.encodeFunctionData("execute", [
          setup.accountAddress,
          0n,
          LEGACY_SET_EAS.encodeFunctionData("setEas", [setup.delegate.address]),
        ]),
      });
      expect(success).to.equal(false);
      expect(await setup.account.getEas()).to.equal(setup.easAddress);
    });

    it("rejects deploying the extension with a non-contract EAS", async function () {
      const setup = await loadFixture(managedAccountFixture);
      const Extension = await ethers.getContractFactory("SeedProtocolExtension");
      const [eas] = await expectCustomError(
        Extension.deploy(setup.stranger.address),
        Extension.interface,
        "InvalidEAS",
      );
      expect(eas).to.equal(setup.stranger.address);
    });
  });

  describe("D7(a): everything published is revocable by the owner", function () {
    it("forces seed and property attestations revocable even when the request asks otherwise", async function () {
      const setup = await loadFixture(managedAccountFixture);
      const requests = buildLegacyPublishRequests(setup, { revocable: false });
      const receipt = await (await setup.account.connect(setup.accountAdmin).multiPublish(requests)).wait();

      const attested = attestedEvents(setup.eas, receipt);
      expect(attested).to.have.length(3);
      for (const { uid } of attested) {
        expect((await setup.eas.getAttestation(uid)).revocable).to.equal(true);
      }
    });

    it("lets the owner revoke what a delegate published, after revoking the delegate", async function () {
      const setup = await loadFixture(managedAccountFixture);
      await grantSessionKey(setup.account, setup.accountAdmin, setup.delegate.address, {
        approvedTargets: [setup.accountAddress],
      });

      const publish = setup.account.interface.encodeFunctionData("multiPublish", [
        buildLegacyPublishRequests(setup, { revocable: false, propertyValue: "spam" }),
      ]);
      const { success, receipt } = await sendUserOp({
        ...setup,
        signer: setup.delegate,
        callData: setup.account.interface.encodeFunctionData("execute", [setup.accountAddress, 0n, publish]),
      });
      expect(success).to.equal(true);

      await revokeSessionKey(setup.account, setup.accountAdmin, setup.delegate.address);

      for (const { uid, schema } of attestedEvents(setup.eas, receipt)) {
        await (
          await setup.account
            .connect(setup.accountAdmin)
            .execute(setup.easAddress, 0n, revokeCallData(setup.eas, schema, uid))
        ).wait();
        expect((await setup.eas.getAttestation(uid)).revocationTime).to.be.greaterThan(0n);
      }
    });
  });
});
