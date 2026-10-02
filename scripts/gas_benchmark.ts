/**
 * Gas benchmark script for SeedProtocolExtension multiPublish.
 * Run: npx hardhat run scripts/gas_benchmark.ts
 *
 * Env vars:
 *   REPORT_GAS_OUTPUT=path — write JSON to path (default: gas-reports/gas-report-{timestamp}.json)
 *   GAS_BENCHMARK_BASELINE=path — optional; compute diff vs baseline JSON
 *   GAS_BENCHMARK_VARIANTS=Contract1,Contract2 — optional; compare multiple contract variants
 */
import { ethers, upgrades } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { GAS_PAYLOADS, type GasPayload } from "../test/fixtures/gas_payloads";

const GAS_REPORTS_DIR = path.join(__dirname, "..", "gas-reports");

type SchemaManifest = {
  seedSchemaUid: string;
  seedSchemaUid1?: string;
  seedSchemaUid2?: string;
  seedSchemaUid3?: string;
  versionSchemaUid: string;
  propertySchemaUid: string;
  propertySchemaUid1?: string;
  propertySchemaUid2?: string;
  propertySchemaUid3?: string;
};

function substitutePlaceholders(payload: unknown[], manifest: SchemaManifest): unknown[] {
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
  return replacer(payload) as unknown[];
}

function normalizePayload(payload: any[], usePublishIndex = false): any[] {
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

async function deployExtensionVariant(
  variantName: string,
  easAddress: string
): Promise<{ extension: any; cleanup?: () => Promise<void> }> {
  const Factory = await ethers.getContractFactory(variantName);
  const extension = await upgrades.deployProxy(Factory, [easAddress], {
    initializer: "initialize",
  });
  await extension.waitForDeployment();
  return { extension };
}

async function runBenchmark(
  extension: any,
  payloads: GasPayload[],
  manifest: SchemaManifest,
  usePublishIndex = false
): Promise<Record<string, number>> {
  const results: Record<string, number> = {};
  const [signer] = await ethers.getSigners();
  const extConnected = extension.connect(signer);

  for (const { name, requests } of payloads) {
    const substituted = substitutePlaceholders(requests, manifest) as any[];
    const normalized = normalizePayload(substituted, usePublishIndex);
    const tx = await extConnected.multiPublish(normalized, { value: 0n });
    const receipt = await tx.wait();
    if (receipt && receipt.gasUsed !== undefined) {
      results[name] = Number(receipt.gasUsed);
    }
  }
  return results;
}

function printTable(
  variantResults: Record<string, Record<string, number>>,
  baseline?: Record<string, number>
) {
  const payloadNames = Object.keys(variantResults[Object.keys(variantResults)[0]] || {});
  const variantNames = Object.keys(variantResults);

  const header = ["Payload", ...variantNames];
  if (baseline) header.push("vs baseline");
  console.log("\n" + header.join(" | "));
  console.log("-".repeat(header.join(" | ").length));

  for (const name of payloadNames) {
    const row: (string | number)[] = [name];
    for (const v of variantNames) {
      row.push(variantResults[v][name] ?? "-");
    }
    if (baseline && baseline[name] !== undefined) {
      const current = variantResults[variantNames[0]][name];
      const diff = current - baseline[name];
      row.push(diff >= 0 ? `+${diff}` : `${diff}`);
    }
    console.log(row.join(" | "));
  }
}

async function main() {
  const { extensionEASFixture } = require("../test/fixtures/extensionEASFixture");
  const fixture = await extensionEASFixture();
  const manifest: SchemaManifest = {
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

  const variantsEnv = process.env.GAS_BENCHMARK_VARIANTS;
  const variants = variantsEnv ? variantsEnv.split(",").map((s) => s.trim()) : ["SeedProtocolExtension"];

  const baselinePath = process.env.GAS_BENCHMARK_BASELINE;
  let baseline: Record<string, number> | undefined;
  if (baselinePath) {
    const resolved = path.isAbsolute(baselinePath) ? baselinePath : path.resolve(process.cwd(), baselinePath);
    if (fs.existsSync(resolved)) {
      const data = JSON.parse(fs.readFileSync(resolved, "utf-8"));
      baseline = data.results || data;
    }
  }

  const variantResults: Record<string, Record<string, number>> = {};

  const usePublishIndexFor = (name: string) =>
    name === "SeedProtocolExtensionV2" || name === "SeedProtocolExtensionV3";

  if (variants.length === 1 && variants[0] === "SeedProtocolExtension") {
    const results = await runBenchmark(fixture.extension, GAS_PAYLOADS, manifest, false);
    variantResults["SeedProtocolExtension"] = results;
  } else {
    for (const variantName of variants) {
      const { extension: ext } = await deployExtensionVariant(variantName, await fixture.eas.getAddress());
      const results = await runBenchmark(
        ext,
        GAS_PAYLOADS,
        manifest,
        usePublishIndexFor(variantName)
      );
      variantResults[variantName] = results;
    }
  }

  printTable(variantResults, baseline);

  const outputPath = process.env.REPORT_GAS_OUTPUT;
  if (outputPath) {
    const resolved = path.isAbsolute(outputPath) ? outputPath : path.resolve(process.cwd(), outputPath);
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const report = {
      timestamp: new Date().toISOString(),
      variants: variantResults,
      results: variantResults[Object.keys(variantResults)[0]],
    };
    fs.writeFileSync(resolved, JSON.stringify(report, null, 2), "utf-8");
    console.log("\nReport written to:", resolved);
  } else if (!baselinePath) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const defaultPath = path.join(GAS_REPORTS_DIR, `gas-report-${timestamp}.json`);
    if (!fs.existsSync(GAS_REPORTS_DIR)) fs.mkdirSync(GAS_REPORTS_DIR, { recursive: true });
    const report = {
      timestamp: new Date().toISOString(),
      variants: variantResults,
      results: variantResults[Object.keys(variantResults)[0]],
    };
    fs.writeFileSync(defaultPath, JSON.stringify(report, null, 2), "utf-8");
    console.log("\nReport written to:", defaultPath);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
