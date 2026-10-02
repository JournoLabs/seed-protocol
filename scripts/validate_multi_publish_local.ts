// NOTE: Hardhat 2 script, not yet ported to Hardhat 3. It will be ported or replaced
// in the deploy branch (see docs/hardhat3-migration-plan.md, H9). Expect it to fail until then.

/**
 * Validation script: Run multiPublish against local chain with fixture payload.
 * Prerequisites: Run `bun run scripts/setup_local.ts` first (or have localhost.json + node running).
 *
 * Usage:
 *   npx hardhat run scripts/validate_multi_publish_local.ts --network localhost
 *   FIXTURE_PATH=test/fixtures/multi_publish_simple.json npx hardhat run scripts/validate_multi_publish_local.ts --network localhost
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const MODULE_TYPE_EXECUTOR = 2;
const DEPLOYMENTS_DIR = path.join(__dirname, "..", "deployments");
const LOCALHOST_JSON = path.join(DEPLOYMENTS_DIR, "localhost.json");
const DEFAULT_FIXTURE = path.join(__dirname, "..", "test", "fixtures", "multi_publish_cross_ref.json");

function loadManifest(): Record<string, string> {
  if (!fs.existsSync(LOCALHOST_JSON)) {
    throw new Error(
      `localhost.json not found at ${LOCALHOST_JSON}. Run: bun run scripts/setup_local.ts`
    );
  }
  return JSON.parse(fs.readFileSync(LOCALHOST_JSON, "utf-8"));
}

function loadFixture(fixturePath: string): unknown[] {
  const resolved = path.isAbsolute(fixturePath) ? fixturePath : path.resolve(process.cwd(), fixturePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Fixture not found: ${resolved}`);
  }
  return JSON.parse(fs.readFileSync(resolved, "utf-8"));
}

function substitutePlaceholders(
  payload: unknown[],
  manifest: Record<string, string>
): unknown[] {
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

function normalizePayload(payload: unknown[]): unknown[] {
  return payload.map((req: any) => ({
    localId: req.localId,
    seedUid: req.seedUid,
    seedSchemaUid: req.seedSchemaUid,
    versionUid: req.versionUid,
    versionSchemaUid: req.versionSchemaUid,
    seedIsRevocable: req.seedIsRevocable,
    listOfAttestations: (req.listOfAttestations || []).map((a: any) => ({
      schema: a.schema,
      data: (a.data || []).map((d: any) => ({
        recipient: d.recipient,
        expirationTime: typeof d.expirationTime === "string" ? BigInt(d.expirationTime) : (d.expirationTime ?? 0),
        revocable: d.revocable,
        refUID: d.refUID,
        data: d.data,
        value: typeof d.value === "string" ? BigInt(d.value) : (d.value ?? 0n),
      })),
    })),
    propertiesToUpdate: (req.propertiesToUpdate || []).map((p: any) => ({
      publishIndex: typeof p.publishIndex === "string" ? parseInt(p.publishIndex, 10) : p.publishIndex,
      propertySchemaUid: p.propertySchemaUid,
    })),
  }));
}

function getEASAttestedUids(receipt: { logs: any[] }, easAddr: string, easInterface: any): string[] {
  const uids: string[] = [];
  const addr = easAddr.toLowerCase();
  for (const log of receipt.logs) {
    if ((log as any).address?.toLowerCase() !== addr) continue;
    try {
      const parsed = easInterface.parseLog({ topics: log.topics, data: log.data });
      if (parsed && parsed.name === "Attested") uids.push(parsed.args[2]);
    } catch {}
  }
  return uids;
}

async function main() {
  const manifest = loadManifest();
  const fixturePath = process.env.FIXTURE_PATH || DEFAULT_FIXTURE;
  const rawPayload = loadFixture(fixturePath) as any[];
  const substituted = substitutePlaceholders(rawPayload, manifest);
  const payload = normalizePayload(substituted);

  const [signer] = await ethers.getSigners();
  const executorAddr = manifest.SeedProtocolExecutor;
  const easAddr = manifest.easAddress;

  if (!executorAddr || !easAddr) {
    throw new Error("Manifest missing SeedProtocolExecutor or easAddress");
  }

  const Executor = await ethers.getContractFactory("SeedProtocolExecutor");
  const executor = Executor.connect(signer).attach(executorAddr);

  const EAS = await ethers.getContractFactory("EAS");
  const eas = EAS.attach(easAddr);

  const Account = await ethers.getContractFactory("MockERC7579Account");
  const account = await Account.deploy(signer.address);
  await account.waitForDeployment();

  const initData = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address"],
    [easAddr]
  );
  await account.installModule(MODULE_TYPE_EXECUTOR, executorAddr, initData);

  const calldata = executor.interface.encodeFunctionData("multiPublish", [payload]);
  const tx = await account.execute(executorAddr, 0n, calldata, { value: 0n });
  const receipt = await tx.wait();

  console.log("multiPublish succeeded.");
  console.log("Gas used:", receipt!.gasUsed.toString());

  const uids = getEASAttestedUids(receipt!, easAddr, eas.interface);
  console.log("EAS attestation UIDs:", uids.length);

  const isCrossRef = rawPayload.some(
    (r: any) => Array.isArray(r.propertiesToUpdate) && r.propertiesToUpdate.length > 0
  );

  if (isCrossRef && uids.length >= 5) {
    const parentSeedUid = uids[0];
    const childPropertyUid = uids[4];
    const childPropertyAtt = await eas.getAttestation(childPropertyUid);
    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
      ["bytes32"],
      childPropertyAtt.data
    );
    if (decoded[0] === parentSeedUid) {
      console.log("Cross-reference validation: child property data contains parent seed UID.");
    } else {
      console.error("Cross-reference validation FAILED: expected", parentSeedUid, "got", decoded[0]);
      process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
