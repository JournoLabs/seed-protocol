/**
 * Compares Hardhat 2 artifacts against Hardhat 3 artifacts to prove the
 * migration didn't change what we deploy (docs/hardhat3-migration-plan.md, H4).
 *
 * Usage:
 *   bun scripts/check_bytecode_parity.ts <hardhat2-artifacts-dir> [hardhat3-artifacts-dir]
 *
 * Metadata hashes are expected to differ (Hardhat 3 uses different source
 * names), so every embedded CBOR metadata blob is blanked before comparing.
 * Library link placeholders are also derived from source names, so they're
 * normalised too. Exits non-zero if any production contract differs.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const PRODUCTION_CONTRACTS = [
  'SeedProtocolExecutor',
  'SeedProtocolExtension',
  'SeedProtocolExtensionV2',
  'SeedExecutorRouterExtension',
]

// ipfs multihash (34 bytes) + "solc" + 3-byte version + 2-byte length 0x0033
const METADATA_BLOB = /a264697066735822[0-9a-f]{68}64736f6c6343[0-9a-f]{6}0033/g
const LINK_PLACEHOLDER = /__\$[0-9a-f]{34}\$__/g

interface Artifact {
  contractName: string
  sourceName: string
  bytecode: string
  deployedBytecode: string
}

function findArtifacts(dir: string): Map<string, Artifact> {
  const found = new Map<string, Artifact>()
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry)
      if (statSync(full).isDirectory()) {
        if (entry !== 'build-info') walk(full)
        continue
      }
      if (!entry.endsWith('.json') || entry.endsWith('.dbg.json')) continue
      const json = JSON.parse(readFileSync(full, 'utf8'))
      if (typeof json.deployedBytecode !== 'string' || json.deployedBytecode === '0x') continue
      // Key on the path under artifacts/ (e.g. contracts/Foo.sol/Foo.json),
      // which is the same layout in both Hardhat versions.
      found.set(relative(dir, full), json as Artifact)
    }
  }
  walk(dir)
  return found
}

function normalise(bytecode: string): string {
  return bytecode
    .toLowerCase()
    .replace(METADATA_BLOB, '<metadata>')
    .replace(LINK_PLACEHOLDER, '<library>')
}

const [hh2Dir, hh3Dir = 'artifacts'] = process.argv.slice(2)
if (!hh2Dir || !existsSync(hh2Dir) || !existsSync(hh3Dir)) {
  console.error('Usage: bun scripts/check_bytecode_parity.ts <hardhat2-artifacts-dir> [hardhat3-artifacts-dir]')
  process.exit(2)
}

const hh2 = findArtifacts(hh2Dir)
const hh3 = findArtifacts(hh3Dir)

let productionFailures = 0
const rows: string[] = []
for (const [path, next] of [...hh3].sort(([a], [b]) => a.localeCompare(b))) {
  const prev = hh2.get(path)
  const isProduction = path.startsWith('contracts/') && PRODUCTION_CONTRACTS.includes(next.contractName)
  let status: string
  if (!prev) {
    status = 'MISSING in Hardhat 2'
  } else {
    const runtimeMatches = normalise(prev.deployedBytecode) === normalise(next.deployedBytecode)
    const initMatches = normalise(prev.bytecode) === normalise(next.bytecode)
    status = runtimeMatches && initMatches ? 'match' : `DIFFERS (runtime ${runtimeMatches ? 'ok' : 'differs'}, initcode ${initMatches ? 'ok' : 'differs'})`
  }
  if (isProduction && status !== 'match') productionFailures++
  rows.push(`${isProduction ? '*' : ' '} ${status.padEnd(40)} ${path}`)
}

console.log(rows.join('\n'))
console.log(`\n* = production contract. ${productionFailures === 0 ? 'All production contracts match.' : `${productionFailures} production contract(s) differ.`}`)
process.exit(productionFailures === 0 ? 0 : 1)
