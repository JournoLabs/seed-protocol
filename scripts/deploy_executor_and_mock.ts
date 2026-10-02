// NOTE: Hardhat 2 script, not yet ported to Hardhat 3. It will be ported or replaced
// in the deploy branch (see docs/hardhat3-migration-plan.md, H9). Expect it to fail until then.

import { ethers } from 'hardhat'
import * as fs from 'fs'
import * as path from 'path'

const DEPLOYMENTS_DIR = path.join(__dirname, '..', 'deployments')
const MANIFEST_FILE = path.join(DEPLOYMENTS_DIR, 'executor-and-mock.json')

type DeploymentAddresses = {
  SeedProtocolExecutor?: string
  MockERC7579Account?: string
}

type Manifest = Record<string, DeploymentAddresses>

function loadManifest(): Manifest {
  if (!fs.existsSync(MANIFEST_FILE)) {
    return {}
  }
  const raw = fs.readFileSync(MANIFEST_FILE, 'utf-8')
  try {
    return JSON.parse(raw) as Manifest
  } catch {
    return {}
  }
}

function saveManifest(manifest: Manifest): void {
  if (!fs.existsSync(DEPLOYMENTS_DIR)) {
    fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true })
  }
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2), 'utf-8')
}

async function isContractDeployed(address: string): Promise<boolean> {
  const code = await ethers.provider.getCode(address)
  return code !== undefined && code !== '0x' && code.length > 2
}

/** When "0", "false", or "no", skip deploying MockERC7579Account (use for prod). Default: deploy mock (for testing). */
function shouldDeployMock(): boolean {
  const v = (process.env.DEPLOY_MOCK ?? '1').toLowerCase()
  return v !== '0' && v !== 'false' && v !== 'no'
}

async function main() {
  const deployMock = shouldDeployMock()
  console.log('DEPLOY_MOCK:', deployMock, '(set DEPLOY_MOCK=0 to skip mock for prod)')

  const [deployer] = await ethers.getSigners()
  const network = await ethers.provider.getNetwork()
  const networkName = network.name === 'unknown' ? `chain-${network.chainId}` : network.name

  const manifest = loadManifest()
  const existing = manifest[networkName]

  let executorAddress = existing?.SeedProtocolExecutor
  let mockAccountAddress = existing?.MockERC7579Account

  const needExecutor =
    !executorAddress || !(await isContractDeployed(executorAddress))
  const needMockAccount =
    deployMock && (!mockAccountAddress || !(await isContractDeployed(mockAccountAddress)))

  if (needExecutor) {
    console.log('Deploying SeedProtocolExecutor...')
    const Executor = await ethers.getContractFactory('SeedProtocolExecutor')
    const executor = await Executor.deploy()
    await executor.waitForDeployment()
    executorAddress = await executor.getAddress()
    console.log('SeedProtocolExecutor deployed to:', executorAddress)
  } else {
    console.log('SeedProtocolExecutor already deployed at:', executorAddress)
  }

  if (needMockAccount) {
    console.log('Deploying MockERC7579Account...')
    const Account = await ethers.getContractFactory('MockERC7579Account')
    const account = await Account.deploy(deployer.address)
    await account.waitForDeployment()
    mockAccountAddress = await account.getAddress()
    console.log('MockERC7579Account deployed to:', mockAccountAddress)
  } else if (deployMock && mockAccountAddress) {
    console.log('MockERC7579Account already deployed at:', mockAccountAddress)
  } else if (!deployMock) {
    console.log('MockERC7579Account skipped (DEPLOY_MOCK=0)')
  }

  if (needExecutor || needMockAccount) {
    manifest[networkName] = {
      ...manifest[networkName],
      SeedProtocolExecutor: executorAddress!,
      ...(mockAccountAddress && { MockERC7579Account: mockAccountAddress }),
    }
    saveManifest(manifest)
    console.log('Saved addresses to', MANIFEST_FILE)
  }

  console.log('\n--- Summary ---')
  console.log('Network:', networkName)
  console.log('SeedProtocolExecutor:', executorAddress)
  console.log('MockERC7579Account:', deployMock ? mockAccountAddress ?? 'N/A' : '(skipped)')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
