// NOTE: Hardhat 2 script, not yet ported to Hardhat 3. It will be ported or replaced
// in the deploy branch (see docs/hardhat3-migration-plan.md, H9). Expect it to fail until then.

import { ethers } from 'hardhat'
import { deployToLocalHardhat } from './utils/deploy'
import path from 'path'
import fs from 'fs'

const DEPLOYMENTS_DIR = path.join(__dirname, '..', 'deployments')
const LOCALHOST_EAS_FILE = path.join(DEPLOYMENTS_DIR, 'localhost-eas.json')

async function main() {
  const store = await deployToLocalHardhat()

  const network = await ethers.provider.getNetwork()
  const isLocalhost = network.name === 'localhost' || Number(network.chainId) === 1337
  if (!isLocalhost) {
    console.log('Not localhost; skipping manifest write.')
    return
  }

  const partial = {
    easAddress: store.easAddress,
    schemaRegistryAddress: store.schemaRegistryAddress,
    versionSchemaUid: store.versionSchemaUid,
    postSchemaUid: store.postSchemaUid,
    identitySchemaUid: store.identitySchemaUid,
    nameASchemaUid: store.nameASchemaUid,
    seedSchemaUid: store.seedSchemaUid ?? store.postSchemaUid,
    propertySchemaUid: store.propertySchemaUid,
    SeedProtocolExtension: await store.seedProtocol!.getAddress(),
  }

  if (!fs.existsSync(DEPLOYMENTS_DIR)) {
    fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true })
  }
  fs.writeFileSync(LOCALHOST_EAS_FILE, JSON.stringify(partial, null, 2), 'utf-8')
  console.log('Wrote', LOCALHOST_EAS_FILE)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
