// NOTE: Hardhat 2 script, not yet ported to Hardhat 3. It will be ported or replaced
// in the deploy branch (see docs/hardhat3-migration-plan.md, H9). Expect it to fail until then.

/**
 * Debug script: Simulate multiPublish with a payload to capture the actual EAS revert reason.
 * Run: npx hardhat run scripts/debug_multi_publish.ts --network optimism_sepolia
 *
 * On localhost: uses deployments/localhost.json for extension address and schema UIDs.
 * When localhost.json exists and DEBUG_PAYLOAD_PATH is not set, uses multi_publish_cross_ref.json.
 *
 * Set DEBUG_PAYLOAD_PATH to a JSON file path to override the payload.
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const DEPLOYMENTS_DIR = path.join(__dirname, "..", "deployments");
const LOCALHOST_JSON = path.join(DEPLOYMENTS_DIR, "localhost.json");
const DEFAULT_LOCALHOST_FIXTURE = path.join(__dirname, "..", "test", "fixtures", "multi_publish_cross_ref.json");

function loadManifest(): Record<string, string> | null {
  if (!fs.existsSync(LOCALHOST_JSON)) return null;
  try {
    return JSON.parse(fs.readFileSync(LOCALHOST_JSON, "utf-8"));
  } catch {
    return null;
  }
}

function substitutePlaceholders(payload: unknown[], manifest: Record<string, string>): unknown[] {
  const seedUid = manifest.seedSchemaUid ?? manifest.postSchemaUid;
  const versionUid = manifest.versionSchemaUid;
  const propertyUid = manifest.propertySchemaUid;

  if (!seedUid || !versionUid || !propertyUid) {
    throw new Error("Manifest missing seedSchemaUid, versionSchemaUid, or propertySchemaUid");
  }

  const replacer = (obj: unknown): unknown => {
    if (typeof obj === "string") {
      return obj
        .replace(/__SEED_SCHEMA_UID_1__/g, manifest.seedSchemaUid1 ?? seedUid)
        .replace(/__SEED_SCHEMA_UID_2__/g, manifest.seedSchemaUid2 ?? seedUid)
        .replace(/__SEED_SCHEMA_UID_3__/g, manifest.seedSchemaUid3 ?? seedUid)
        .replace(/__SEED_SCHEMA_UID__/g, seedUid)
        .replace(/__VERSION_SCHEMA_UID__/g, versionUid)
        .replace(/__PROPERTY_SCHEMA_UID_1__/g, manifest.propertySchemaUid1 ?? propertyUid)
        .replace(/__PROPERTY_SCHEMA_UID_2__/g, manifest.propertySchemaUid2 ?? propertyUid)
        .replace(/__PROPERTY_SCHEMA_UID_3__/g, manifest.propertySchemaUid3 ?? propertyUid)
        .replace(/__PROPERTY_SCHEMA_UID__/g, propertyUid);
    }
    if (Array.isArray(obj)) return obj.map(replacer);
    if (obj !== null && typeof obj === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) out[k] = replacer(v);
      return out;
    }
    return obj;
  };

  return replacer(payload) as unknown[];
}

function hasPlaceholders(payload: unknown[]): boolean {
  const str = JSON.stringify(payload);
  return (
    /__SEED_SCHEMA_UID(_\d+)?__/.test(str) ||
    str.includes("__VERSION_SCHEMA_UID__") ||
    /__PROPERTY_SCHEMA_UID(_\d+)?__/.test(str)
  );
}

const DEBUG_PAYLOAD = [
  {
    localId: "51IhR1FeXj",
    seedIsRevocable: true,
    versionSchemaUid: "0x13c0fd59d69dbce40501a41f8b37768d26dd2e2bb0cad64615334d84f7b9bdf6",
    seedUid: "0x0000000000000000000000000000000000000000000000000000000000000000",
    seedSchemaUid: "0x5442a1004fe4152a06ed806367a989942f7051bad21bbed5b98d855509f79aed",
    versionUid: "0x0000000000000000000000000000000000000000000000000000000000000000",
    listOfAttestations: [
      {
        schema: "0x55fdefb36fcbbaebeb7d6b41dc3a1a9666e4e42154267c889de064faa7ede517",
        data: [
          {
            recipient: "0x0000000000000000000000000000000000000000",
            revocable: true,
            value: "0",
            refUID: "0x0000000000000000000000000000000000000000000000000000000000000000",
            expirationTime: "0",
            data:
              "0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000002b5262727948706473626d71313249764a7356387952586d77797349435063304352434845796c4130474e67000000000000000000000000000000000000000000",
          },
        ],
      },
    ],
    propertiesToUpdate: [
      { publishIndex: 1, propertySchemaUid: "0x828e86a6cd8d87aa4c22a715055ec7673df30c4d7e627baef174250086e26ec6" },
    ],
  },
  {
    localId: "qPxsBdhfmn",
    seedUid: "0x0000000000000000000000000000000000000000000000000000000000000000",
    seedIsRevocable: true,
    seedSchemaUid: "0x643b48bb284bb383f4d71fc2f522aa8e6cea611431984041ad69dffb7f0e379e",
    versionSchemaUid: "0x13c0fd59d69dbce40501a41f8b37768d26dd2e2bb0cad64615334d84f7b9bdf6",
    versionUid: "0x0000000000000000000000000000000000000000000000000000000000000000",
    listOfAttestations: [
      {
        schema: "0xdf0de274149c83e667b1fc7195832a8b512a884cc90341945648a87e282f3391",
        data: [
          {
            recipient: "0x0000000000000000000000000000000000000000",
            revocable: true,
            value: "0",
            refUID: "0x0000000000000000000000000000000000000000000000000000000000000000",
            expirationTime: "0",
            data:
              "0x000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000137477656574207769746820616e20696d61676500000000000000000000000000",
          },
        ],
      },
      {
        schema: "0x828e86a6cd8d87aa4c22a715055ec7673df30c4d7e627baef174250086e26ec6",
        data: [
          {
            recipient: "0x0000000000000000000000000000000000000000",
            revocable: true,
            value: "0",
            refUID: "0x0000000000000000000000000000000000000000000000000000000000000000",
            expirationTime: "0",
            data:
              "0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000a3531496852314665586a00000000000000000000000000000000000000000000",
          },
        ],
      },
    ],
    propertiesToUpdate: [],
  },
];

function normalizePayload(payload: any[]): any[] {
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
    propertiesToUpdate: (req.propertiesToUpdate || []).map((p: any) => ({
      publishIndex: typeof p.publishIndex === "string" ? parseInt(p.publishIndex, 10) : p.publishIndex,
      propertySchemaUid: p.propertySchemaUid,
    })),
  }));
}

async function main() {
  const manifest = loadManifest();
  const payloadPath = process.env.DEBUG_PAYLOAD_PATH;

  let payload: any[];
  if (payloadPath) {
    const resolved = path.isAbsolute(payloadPath) ? payloadPath : path.resolve(process.cwd(), payloadPath);
    payload = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  } else if (manifest && fs.existsSync(DEFAULT_LOCALHOST_FIXTURE)) {
    payload = JSON.parse(fs.readFileSync(DEFAULT_LOCALHOST_FIXTURE, "utf-8"));
  } else {
    payload = DEBUG_PAYLOAD;
  }

  if (manifest && hasPlaceholders(payload)) {
    payload = substitutePlaceholders(payload, manifest) as any[];
  }

  const normalized = normalizePayload(payload);
  const [signer] = await ethers.getSigners();
  const extensionAddr =
    manifest?.SeedProtocolExtension ?? process.env.SEED_PROTOCOL_EXTENSION ?? "0xA2b8315fd0F31c334be1B137D9E0FfbB3F200E57";

  const Extension = await ethers.getContractFactory("SeedProtocolExtension");
  const ext = Extension.attach(extensionAddr);

  console.log("Simulating multiPublish (staticCall)...");
  console.log("Extension:", extensionAddr);
  console.log("From:", signer.address);
  console.log("Requests:", normalized.length);

  try {
    const result = await ext.multiPublish.staticCall(normalized, { value: 0n });
    console.log("Success! Result:", result);
  } catch (err: any) {
    console.error("\n--- Revert captured ---");
    console.error("Message:", err.message);
    if (err.data) {
      console.error("Revert data (hex):", err.data);
      try {
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + err.data.slice(138));
        console.error("Decoded Error(string):", decoded[0]);
      } catch (_) {}
    }
    if (err.error?.data) {
      console.error("Error data:", err.error.data);
    }
    if (err.reason) console.error("Reason:", err.reason);
    if (err.shortMessage) console.error("Short:", err.shortMessage);
    process.exitCode = 1;
  }
}

main();
