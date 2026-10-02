/**
 * Compare two gas report JSON files.
 * Run: npx hardhat run scripts/compare_gas_reports.ts
 *
 * Env vars:
 *   GAS_COMPARE_BASELINE=path — baseline report (required)
 *   GAS_COMPARE_CURRENT=path — current report (required, or pass as arg)
 *
 * Or: node -e "require('./scripts/compare_gas_reports')" baseline.json current.json
 */
import * as fs from "fs";
import * as path from "path";

function loadReport(filePath: string): Record<string, number> {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Report not found: ${resolved}`);
  }
  const data = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  return data.results || data.variants?.[Object.keys(data.variants || {})[0]] || data;
}

function compare(
  baseline: Record<string, number>,
  current: Record<string, number>,
  regressionThreshold = 0
): { regressions: string[]; improvements: string[]; unchanged: string[] } {
  const regressions: string[] = [];
  const improvements: string[] = [];
  const unchanged: string[] = [];

  const allPayloads = new Set([...Object.keys(baseline), ...Object.keys(current)]);

  for (const name of allPayloads) {
    const base = baseline[name];
    const curr = current[name];
    if (base === undefined || curr === undefined) continue;
    const diff = curr - base;
    if (diff > regressionThreshold) regressions.push(`${name}: +${diff}`);
    else if (diff < -regressionThreshold) improvements.push(`${name}: ${diff}`);
    else unchanged.push(`${name}: 0`);
  }
  return { regressions, improvements, unchanged };
}

function main() {
  const baselinePath =
    process.env.GAS_COMPARE_BASELINE || process.argv[2];
  const currentPath =
    process.env.GAS_COMPARE_CURRENT || process.argv[3];

  if (!baselinePath || !currentPath) {
    console.error(
      "Usage: GAS_COMPARE_BASELINE=baseline.json GAS_COMPARE_CURRENT=current.json npx hardhat run scripts/compare_gas_reports.ts"
    );
    console.error("   or: npx hardhat run scripts/compare_gas_reports.ts baseline.json current.json");
    process.exitCode = 1;
    return;
  }

  const baseline = loadReport(baselinePath);
  const current = loadReport(currentPath);
  const { regressions, improvements, unchanged } = compare(baseline, current);

  const payloadNames = [...new Set([...Object.keys(baseline), ...Object.keys(current)])].sort();
  console.log("\nPayload    | Baseline | Current  | Diff");
  console.log("-".repeat(45));
  for (const name of payloadNames) {
    const base = baseline[name];
    const curr = current[name];
    if (base === undefined || curr === undefined) continue;
    const diff = curr - base;
    const diffStr = diff >= 0 ? `+${diff}` : `${diff}`;
    console.log(`${name.padEnd(10)} | ${String(base).padStart(8)} | ${String(curr).padStart(8)} | ${diffStr}`);
  }

  if (improvements.length > 0) {
    console.log("\nImprovements:", improvements.join(", "));
  }
  if (regressions.length > 0) {
    console.log("\nRegressions:", regressions.join(", "));
    process.exitCode = 1;
  }
}

main();
