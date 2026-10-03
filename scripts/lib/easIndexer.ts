import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { ROOT } from "./orchestration.js";

/**
 * The twin's EAS indexer: the official eas-indexing-service in infra/eas-indexer, seeded
 * with OP Sepolia's pre-fork data from easscan (docs/local-twin-plan.md, §9).
 */

const COMPOSE_FILE = path.join(ROOT, "infra/eas-indexer/docker-compose.yml");
const EASSCAN_OP_SEPOLIA = "https://optimism-sepolia.easscan.org/graphql";

export interface IndexerChain {
  chainId: number;
  eas: string;
  schemaRegistry: string;
  /** The first block the indexer reads from the chain: the fork block + 1. */
  startBlock: number;
  /** As seen from inside the container. */
  rpcUrl: string;
}

function compose(args: string[], { env = {}, input }: { env?: Record<string, string>; input?: string } = {}) {
  const result = spawnSync("docker", ["compose", "-f", COMPOSE_FILE, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    input,
    encoding: "utf8",
    maxBuffer: 1 << 30,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(`docker compose ${args[0]} failed:\n${result.stderr}`);
  return result.stdout;
}

export function dockerAvailable(): boolean {
  return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
}

/** Starts Postgres and the indexer with an empty database (the twin restarts from the fork block). */
export function startIndexer(chain: IndexerChain) {
  compose(["down", "-v", "--remove-orphans"]);
  compose(["up", "-d", "--build", "--wait", "postgres"]);
  compose(["up", "-d", "indexer"], {
    env: {
      CHAIN_ID: String(chain.chainId),
      EAS_CUSTOM_CHAIN: JSON.stringify({
        chainId: chain.chainId,
        chainName: "seed-twin",
        subdomain: "",
        version: "1.0.2",
        contractAddress: chain.eas,
        schemaRegistryAddress: chain.schemaRegistry,
        etherscanURL: "",
        contractStartBlock: chain.startBlock,
        rpcProvider: chain.rpcUrl,
      }),
    },
  });
}

export function stopIndexer() {
  compose(["down", "-v", "--remove-orphans"]);
}

/** Polls the indexer's GraphQL until it answers. */
export async function waitForGraphql(url: string, timeoutMs = 180_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      if ((await graphql(url, "{ __typename }")).__typename) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`The EAS indexer at ${url} didn't come up; see \`docker compose -f ${path.relative(ROOT, COMPOSE_FILE)} logs indexer\``);
}

export async function graphql(url: string, query: string, variables: Record<string, unknown> = {}): Promise<any> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables }) });
  const body = (await res.json()) as { data?: any; errors?: unknown };
  if (body.errors) throw new Error(`GraphQL: ${JSON.stringify(body.errors)}`);
  return body.data;
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

export interface SeedData {
  forkTimestamp: number;
  schemas: Record<string, unknown>[];
  schemaNames: Record<string, unknown>[];
  /** Absent for a light seed. */
  attestations?: Record<string, unknown>[];
}

const FIELDS = {
  schemata: "id schema creator resolver revocable index txid time",
  schemaNames: "id schemaId attesterAddress name time isCreator",
  attestations:
    "id data decodedDataJson recipient attester time timeCreated expirationTime revocationTime refUID revocable revoked txid schemaId ipfsHash isOffchain",
};
const WHERE_TYPES = { schemata: "SchemaWhereInput", schemaNames: "SchemaNameWhereInput", attestations: "AttestationWhereInput" };

/** Every row of `field` matching `where`. Ordered by (time, id): many rows share a time, and paging by time alone skips some. */
async function fetchAll(field: keyof typeof FIELDS, where: object, pageSize: number) {
  const rows: Record<string, unknown>[] = [];
  for (let skip = 0; ; skip += pageSize) {
    const data = await graphql(
      EASSCAN_OP_SEPOLIA,
      `query($where: ${WHERE_TYPES[field]}, $take: Int, $skip: Int) {
        ${field}(where: $where, take: $take, skip: $skip, orderBy: [{ time: asc }, { id: asc }]) { ${FIELDS[field]} }
      }`,
      { where, take: pageSize, skip },
    );
    rows.push(...data[field]);
    if (data[field].length < pageSize) return rows;
  }
}

/** easscan's data as of `forkTimestamp`: later revocations didn't happen yet on the twin. */
export function asOfFork(attestations: Record<string, any>[], forkTimestamp: number) {
  return attestations.map((a) =>
    a.revoked && a.revocationTime > forkTimestamp ? { ...a, revoked: false, revocationTime: 0 } : a,
  );
}

/**
 * OP Sepolia's schemas, schema names and (unless `light`) on-chain attestations up to
 * `forkTimestamp`, from easscan. Cached in .twin/ per fork block, so only the first `up`
 * for a block downloads anything.
 */
export async function loadSeedData(forkBlock: number, forkTimestamp: number, { light }: { light: boolean }): Promise<SeedData> {
  const cache = path.join(ROOT, ".twin", `indexer-seed-${forkBlock}${light ? "-light" : ""}.json.gz`);
  if (existsSync(cache)) return JSON.parse(gunzipSync(readFileSync(cache)).toString("utf8"));

  const before = { time: { lte: forkTimestamp } };
  const data: SeedData = {
    forkTimestamp,
    schemas: await fetchAll("schemata", before, 500),
    schemaNames: await fetchAll("schemaNames", before, 500),
    ...(light ? {} : {
      attestations: asOfFork(await fetchAll("attestations", { ...before, isOffchain: { equals: false } }, 1000), forkTimestamp),
    }),
  };
  mkdirSync(path.dirname(cache), { recursive: true });
  writeFileSync(cache, gzipSync(JSON.stringify(data)));
  return data;
}

/** Bulk-inserts the seed into the indexer's Postgres (tables must exist: the indexer creates them on start). */
export function insertSeedData(data: SeedData) {
  const insert = (table: string, rows: Record<string, unknown>[]) => {
    for (let i = 0; i < rows.length; i += 2000) {
      const json = JSON.stringify(rows.slice(i, i + 2000));
      if (json.includes("$seed$")) throw new Error("seed data contains the SQL quote tag $seed$");
      compose(["exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-q", "-U", "postgres", "-d", "eas-index"], {
        input: `INSERT INTO "${table}" SELECT * FROM json_populate_recordset(null::"${table}", $seed$${json}$seed$) ON CONFLICT DO NOTHING;`,
      });
    }
  };
  insert("Schema", data.schemas);
  insert("SchemaName", data.schemaNames);
  if (data.attestations) insert("Attestation", data.attestations);
}

/** Whether the indexer has created its tables yet. */
export function tablesExist(): boolean {
  try {
    const out = compose(["exec", "-T", "postgres", "psql", "-tA", "-U", "postgres", "-d", "eas-index", "-c", `SELECT to_regclass('public."Attestation"') IS NOT NULL`]);
    return out.trim() === "t";
  } catch {
    return false;
  }
}
