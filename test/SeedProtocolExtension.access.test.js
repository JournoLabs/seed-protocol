/**
 * Access control for SeedProtocolExtension when routed through a thirdweb
 * ManagedAccount. See docs/security/extension-access-control-plan.md (F1, F2).
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const {
  managedAccountFixture,
  grantSessionKey,
  sendUserOp,
  attestedEvents,
  buildLegacyPublishRequests,
} = require("./fixtures/managedAccountFixture");

async function readyFixture() {
  const setup = await loadFixture(managedAccountFixture);
  await (await setup.account.connect(setup.accountAdmin).setEas(setup.easAddress)).wait();
  return setup;
}

describe("SeedProtocolExtension access control", function () {
  /**
   * Demonstrates F1/F2 against the extension as currently deployed. These pass
   * today and are removed by the fix; the pending block below replaces them.
   */
  describe("current behaviour (vulnerable)", function () {
    it("F1: a stranger can publish a non-revocable attestation as the account", async function () {
      const setup = await readyFixture();
      const forged = buildLegacyPublishRequests(setup, { revocable: false, propertyValue: "forged" });

      const receipt = await (await setup.account.connect(setup.stranger).multiPublish(forged)).wait();
      const attested = attestedEvents(setup.eas, receipt);

      expect(attested).to.have.length(3);
      for (const { attester } of attested) {
        expect(attester).to.equal(setup.accountAddress);
      }

      // The attacker-supplied property is permanent and carries their data.
      // (Version attestations are always revocable; the seed and properties follow the request.)
      const property = attested.find((a) => a.schema === setup.propertySchemaUid);
      const onChain = await setup.eas.getAttestation(property.uid);
      expect(onChain.revocable).to.equal(false);
      expect(ethers.AbiCoder.defaultAbiCoder().decode(["string"], onChain.data)[0]).to.equal("forged");
      const seed = attested.find((a) => a.schema === setup.seedSchemaUid);
      expect((await setup.eas.getAttestation(seed.uid)).revocable).to.equal(false);
    });

    it("F2: a stranger can redirect the account's EAS", async function () {
      const setup = await readyFixture();
      await (await setup.account.connect(setup.stranger).setEas(setup.stranger.address)).wait();
      expect(await setup.account.getEas()).to.equal(setup.stranger.address);
    });

    it("F2: a publishing session key can also redirect the account's EAS", async function () {
      const setup = await readyFixture();
      await grantSessionKey(setup.account, setup.accountAdmin, setup.delegate.address, {
        approvedTargets: [setup.accountAddress],
      });
      const setEasCallData = setup.account.interface.encodeFunctionData("setEas", [setup.delegate.address]);
      const { success } = await sendUserOp({
        ...setup,
        signer: setup.delegate,
        callData: setup.account.interface.encodeFunctionData("execute", [setup.accountAddress, 0n, setEasCallData]),
      });
      expect(success).to.equal(true);
      expect(await setup.account.getEas()).to.equal(setup.delegate.address);
    });
  });

  // Enabled by the fix (plan step 3).
  describe("after fix", function () {
    it.skip("rejects multiPublish from a stranger");
    it.skip("rejects multiPublish from a session key calling the account directly (not via execute)");
    it.skip("does not route setEas at all");
    it.skip("returns the constructor-pinned EAS from getEas without per-account setup");
    it.skip("still allows admin EOA, admin UserOp and session-key publishing");
  });
});
