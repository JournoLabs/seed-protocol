/**
 * multiPublish cross-references (`propertiesToUpdate`): a request's new seed UID is
 * written into a property attestation of another request in the same batch.
 * See docs/security/extension-access-control-plan.md (F9).
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const {
  managedAccountFixture,
  managedAccountV2Fixture,
  expectCustomError,
  attestedEvents,
} = require("./fixtures/managedAccountFixture");

const coder = ethers.AbiCoder.defaultAbiCoder();

const VARIANTS = [
  {
    label: "SeedProtocolExtension (legacy)",
    fixture: managedAccountFixture,
    reference: (targetIndex, propertySchemaUid) => ({ publishLocalId: `request-${targetIndex}`, propertySchemaUid }),
  },
  {
    label: "SeedProtocolExtensionV2",
    fixture: managedAccountV2Fixture,
    reference: (targetIndex, propertySchemaUid) => ({ publishIndex: targetIndex, propertySchemaUid }),
  },
];

/**
 * `count` requests, each creating a seed + version and one `bytes32 ref` property.
 * `refs` is a list of `{ from, to }`: request `from`'s new seed UID goes into request `to`'s ref property.
 */
function buildBatch(
  setup,
  reference,
  count,
  refs,
  { emptyDataAt = [], refSchema, duplicateAttestationAt = [], twoEntriesAt = [] } = {},
) {
  const schema = setup.propertySchemaUid2; // "bytes32 ref"
  const entry = () => ({
    recipient: ethers.ZeroAddress,
    expirationTime: 0n,
    revocable: true,
    refUID: ethers.ZeroHash,
    data: coder.encode(["bytes32"], [ethers.ZeroHash]),
    value: 0n,
  });
  const dataFor = (i) => (emptyDataAt.includes(i) ? [] : twoEntriesAt.includes(i) ? [entry(), entry()] : [entry()]);
  return Array.from({ length: count }, (_, i) => ({
    localId: `request-${i}`,
    seedUid: ethers.ZeroHash,
    seedSchemaUid: setup.seedSchemaUid,
    versionUid: ethers.ZeroHash,
    versionSchemaUid: setup.versionSchemaUid,
    seedIsRevocable: true,
    listOfAttestations: [
      { schema, data: dataFor(i) },
      ...(duplicateAttestationAt.includes(i) ? [{ schema, data: [entry()] }] : []),
    ],
    propertiesToUpdate: refs.filter((r) => r.from === i).map((r) => reference(r.to, refSchema ?? schema)),
  }));
}

/** Seed, version and ref-property UIDs per request, in batch order. */
function uidsByRequest(setup, receipt) {
  const attested = attestedEvents(setup.eas, receipt);
  const pick = (schema) => attested.filter((a) => a.schema === schema).map((a) => a.uid);
  const seeds = pick(setup.seedSchemaUid);
  const versions = pick(setup.versionSchemaUid);
  const properties = pick(setup.propertySchemaUid2);
  return seeds.map((seed, i) => ({ seed, version: versions[i], property: properties[i] }));
}

async function refValue(setup, uid) {
  return coder.decode(["bytes32"], (await setup.eas.getAttestation(uid)).data)[0];
}

for (const { label, fixture, reference } of VARIANTS) {
  describe(`${label} cross-references`, function () {
    async function publish(setup, batch) {
      return (await setup.account.connect(setup.accountAdmin).multiPublish(batch)).wait();
    }

    it("writes a request's seed UID into a later request's property", async function () {
      const setup = await loadFixture(fixture);
      const receipt = await publish(setup, buildBatch(setup, reference, 2, [{ from: 0, to: 1 }]));
      const [first, second] = uidsByRequest(setup, receipt);

      expect(await refValue(setup, second.property)).to.equal(first.seed);
      expect(await refValue(setup, first.property)).to.equal(ethers.ZeroHash);
    });

    it("allows a request to reference itself", async function () {
      const setup = await loadFixture(fixture);
      const receipt = await publish(setup, buildBatch(setup, reference, 1, [{ from: 0, to: 0 }]));
      const [only] = uidsByRequest(setup, receipt);

      expect(await refValue(setup, only.property)).to.equal(only.seed);
    });

    it("points each request's properties at its own new version", async function () {
      const setup = await loadFixture(fixture);
      const receipt = await publish(setup, buildBatch(setup, reference, 2, [{ from: 0, to: 1 }]));

      for (const { version, property } of uidsByRequest(setup, receipt)) {
        expect((await setup.eas.getAttestation(property)).refUID).to.equal(version);
      }
    });

    it("preserves a refUID the client set instead of pointing it at the new version", async function () {
      const setup = await loadFixture(fixture);
      const [earlier] = uidsByRequest(setup, await publish(setup, buildBatch(setup, reference, 1, [])));

      const batch = buildBatch(setup, reference, 1, []);
      batch[0].listOfAttestations[0].data[0].refUID = earlier.seed;
      const [published] = uidsByRequest(setup, await publish(setup, batch));

      expect((await setup.eas.getAttestation(published.property)).refUID).to.equal(earlier.seed);
      expect(published.version).to.not.equal(earlier.seed);
    });

    it("rejects referencing a request that was already attested", async function () {
      const setup = await loadFixture(fixture);
      const [requestIndex, targetIndex] = await expectCustomError(
        publish(setup, buildBatch(setup, reference, 2, [{ from: 1, to: 0 }])),
        setup.account.interface,
        "PublishTargetAlreadyAttested",
      );
      expect(requestIndex).to.equal(1n);
      expect(targetIndex).to.equal(0n);
    });

    it("rejects a cross-referenced property with no data entry", async function () {
      const setup = await loadFixture(fixture);
      const [targetIndex, schema] = await expectCustomError(
        publish(setup, buildBatch(setup, reference, 2, [{ from: 0, to: 1 }], { emptyDataAt: [1] })),
        setup.account.interface,
        "EmptyAttestationData",
      );
      expect(targetIndex).to.equal(1n);
      expect(schema).to.equal(setup.propertySchemaUid2);
    });

    for (const [shape, options] of [
      ["two attestations", { duplicateAttestationAt: [1] }],
      ["two data entries", { twoEntriesAt: [1] }],
    ]) {
      it(`rejects a reference that matches ${shape} with the schema rather than overwrite client data`, async function () {
        const setup = await loadFixture(fixture);
        const [targetIndex, schema] = await expectCustomError(
          publish(setup, buildBatch(setup, reference, 2, [{ from: 0, to: 1 }], options)),
          setup.account.interface,
          "AmbiguousPropertyToUpdate",
        );
        expect(targetIndex).to.equal(1n);
        expect(schema).to.equal(setup.propertySchemaUid2);
      });
    }

    it("rejects a reference to a property schema the target request doesn't contain", async function () {
      const setup = await loadFixture(fixture);
      const missingSchema = setup.propertySchemaUid3; // registered, but not in any request
      const [requestIndex, targetIndex, schema] = await expectCustomError(
        publish(setup, buildBatch(setup, reference, 2, [{ from: 0, to: 1 }], { refSchema: missingSchema })),
        setup.account.interface,
        "PropertyToUpdateNotFound",
      );
      expect(requestIndex).to.equal(0n);
      expect(targetIndex).to.equal(1n);
      expect(schema).to.equal(missingSchema);
    });
  });
}

describe("cross-references outside the batch", function () {
  it("V2 rejects an out-of-bounds publishIndex", async function () {
    const setup = await loadFixture(managedAccountV2Fixture);
    const batch = buildBatch(setup, VARIANTS[1].reference, 1, [{ from: 0, to: 5 }]);
    const [targetIndex, length] = await expectCustomError(
      setup.account.connect(setup.accountAdmin).multiPublish(batch),
      setup.account.interface,
      "PublishIndexOutOfBounds",
    );
    expect(targetIndex).to.equal(5n);
    expect(length).to.equal(1n);
  });

  it("legacy rejects an unknown publishLocalId", async function () {
    const setup = await loadFixture(managedAccountFixture);
    const batch = buildBatch(setup, VARIANTS[0].reference, 1, [{ from: 0, to: 5 }]);
    const [localId] = await expectCustomError(
      setup.account.connect(setup.accountAdmin).multiPublish(batch),
      setup.account.interface,
      "UnknownPublishLocalId",
    );
    expect(localId).to.equal("request-5");
  });
});
