/**
 * Gas benchmark tests for SeedProtocolExtension.
 * Run with `bun run test:gas` (hardhat test --gas-stats) to see gas usage.
 */
import { expect } from "chai";
import { network } from "hardhat";
import { createExtensionEASFixture } from "./fixtures/extensionEASFixture.js";
import { GAS_PAYLOADS } from "./fixtures/gas_payloads.js";
import { createManagedAccountFixtures } from "./fixtures/managedAccountFixture.js";

const connection = await network.create();
const { loadFixture } = connection.networkHelpers;
const extensionEASFixture = createExtensionEASFixture(createManagedAccountFixtures(connection));

type Manifest = Record<
  | "seedSchemaUid"
  | "seedSchemaUid1"
  | "seedSchemaUid2"
  | "seedSchemaUid3"
  | "versionSchemaUid"
  | "propertySchemaUid"
  | "propertySchemaUid1"
  | "propertySchemaUid2"
  | "propertySchemaUid3",
  string
>;

function substitutePlaceholders(payload: unknown[], manifest: Manifest): any[] {
  const replacer = (obj: unknown): unknown => {
    if (typeof obj === "string") {
      return obj
        .replace(/__SEED_SCHEMA_UID_1__/g, manifest.seedSchemaUid1 ?? manifest.seedSchemaUid)
        .replace(/__SEED_SCHEMA_UID_2__/g, manifest.seedSchemaUid2 ?? manifest.seedSchemaUid)
        .replace(/__SEED_SCHEMA_UID_3__/g, manifest.seedSchemaUid3 ?? manifest.seedSchemaUid)
        .replace(/__SEED_SCHEMA_UID__/g, manifest.seedSchemaUid)
        .replace(/__VERSION_SCHEMA_UID__/g, manifest.versionSchemaUid)
        .replace(/__PROPERTY_SCHEMA_UID_1__/g, manifest.propertySchemaUid1 ?? manifest.propertySchemaUid)
        .replace(/__PROPERTY_SCHEMA_UID_2__/g, manifest.propertySchemaUid2 ?? manifest.propertySchemaUid)
        .replace(/__PROPERTY_SCHEMA_UID_3__/g, manifest.propertySchemaUid3 ?? manifest.propertySchemaUid)
        .replace(/__PROPERTY_SCHEMA_UID__/g, manifest.propertySchemaUid);
    }
    if (Array.isArray(obj)) return obj.map(replacer);
    if (obj !== null && typeof obj === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) out[k] = replacer(v);
      return out;
    }
    return obj;
  };
  return replacer(payload) as any[];
}

function normalizePayload(payload: any[], usePublishIndex = false) {
  const localIdToIndex: Record<string, number> = {};
  payload.forEach((req, i) => {
    localIdToIndex[req.localId] = i;
  });

  return payload.map((req) => ({
    localId: req.localId,
    seedUid: req.seedUid,
    seedSchemaUid: req.seedSchemaUid,
    versionUid: req.versionUid,
    versionSchemaUid: req.versionSchemaUid,
    seedIsRevocable: req.seedIsRevocable,
    listOfAttestations: req.listOfAttestations.map((a: any) => ({
      schema: a.schema,
      data: a.data.map((d: any) => ({
        recipient: d.recipient,
        expirationTime: typeof d.expirationTime === "string" ? BigInt(d.expirationTime) : d.expirationTime,
        revocable: d.revocable,
        refUID: d.refUID,
        data: d.data,
        value: typeof d.value === "string" ? BigInt(d.value) : d.value,
      })),
    })),
    propertiesToUpdate: (req.propertiesToUpdate || []).map((p: any) => {
      if (usePublishIndex && "publishLocalId" in p) {
        const idx = localIdToIndex[p.publishLocalId];
        if (idx === undefined) throw new Error(`Unknown publishLocalId: ${p.publishLocalId}`);
        return { publishIndex: idx, propertySchemaUid: p.propertySchemaUid };
      }
      if ("publishLocalId" in p) {
        return { publishLocalId: p.publishLocalId, propertySchemaUid: p.propertySchemaUid };
      }
      return {
        publishIndex: typeof p.publishIndex === "string" ? parseInt(p.publishIndex, 10) : p.publishIndex,
        propertySchemaUid: p.propertySchemaUid,
      };
    }),
  }));
}

describe("SeedProtocolExtension (gas)", function () {
  let extension: Awaited<ReturnType<typeof extensionEASFixture>>["extension"];
  let owner: Awaited<ReturnType<typeof extensionEASFixture>>["owner"];
  let manifest: Manifest;

  beforeEach(async function () {
    const fixture = await loadFixture(extensionEASFixture);
    extension = fixture.extension;
    owner = fixture.owner;
    manifest = {
      seedSchemaUid: fixture.seedSchemaUid,
      seedSchemaUid1: fixture.seedSchemaUid1,
      seedSchemaUid2: fixture.seedSchemaUid2,
      seedSchemaUid3: fixture.seedSchemaUid3,
      versionSchemaUid: fixture.versionSchemaUid,
      propertySchemaUid: fixture.propertySchemaUid,
      propertySchemaUid1: fixture.propertySchemaUid1,
      propertySchemaUid2: fixture.propertySchemaUid2,
      propertySchemaUid3: fixture.propertySchemaUid3,
    };
  });

  for (const { name, requests } of GAS_PAYLOADS) {
    it(`multiPublish: ${name}`, async function () {
      const substituted = substitutePlaceholders(requests, manifest);
      const normalized = normalizePayload(substituted, false);
      const extConnected = extension.connect(owner);
      const tx = await extConnected.multiPublish(normalized, { value: 0n });
      const receipt = await tx.wait();
      expect(receipt?.status).to.equal(1);
    });
  }
});
