import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'

const DEPLOYMENTS_DIR = path.join(__dirname, '..', 'deployments')
const LOCALHOST_JSON = path.join(DEPLOYMENTS_DIR, 'localhost.json')
const LOCALHOST_EAS_JSON = path.join(DEPLOYMENTS_DIR, 'localhost-eas.json')
const EXECUTOR_MOCK_JSON = path.join(DEPLOYMENTS_DIR, 'executor-and-mock.json')
const RPC_URL = 'http://127.0.0.1:8545'
const RPC_TIMEOUT_MS = 15000
const RPC_POLL_MS = 500

function run(cmd: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit', shell: true })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code !== undefined) resolve(code)
      else reject(new Error(`Process exited with signal ${signal}`))
    })
  })
}

async function rpcRequest(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const data = (await res.json()) as { result?: unknown; error?: { message: string } }
  if (data.error) throw new Error(data.error.message)
  return data.result
}

async function waitForRPC(): Promise<void> {
  const deadline = Date.now() + RPC_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      await rpcRequest('eth_blockNumber')
      return
    } catch {
      await new Promise((r) => setTimeout(r, RPC_POLL_MS))
    }
  }
  throw new Error(`RPC at ${RPC_URL} not ready within ${RPC_TIMEOUT_MS}ms`)
}

async function hasCodeAtAddress(address: string): Promise<boolean> {
  const code = (await rpcRequest('eth_getCode', [address, 'latest'])) as string
  return !!code && code !== '0x' && code.length > 2
}

async function main() {
  const force = process.argv.includes('--force')

  if (!fs.existsSync(DEPLOYMENTS_DIR)) {
    fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true })
  }

  // Idempotency: if localhost.json exists and EAS has code, skip unless --force
  if (!force && fs.existsSync(LOCALHOST_JSON)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(LOCALHOST_JSON, 'utf-8'))
      if (manifest.easAddress && (await hasCodeAtAddress(manifest.easAddress))) {
        console.log('Already set up. Use --force to re-deploy.')
        process.exit(0)
      }
    } catch {
      // invalid json or RPC down; proceed with deploy
    }
  }

  // 1. If RPC already up (e.g. user started node), skip spawning
  const quickDeadline = Date.now() + 2000
  let rpcReady = false
  while (Date.now() < quickDeadline) {
    try {
      await rpcRequest('eth_blockNumber')
      rpcReady = true
      break
    } catch {
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  if (!rpcReady) {
    console.log('Starting Hardhat node...')
    const node = spawn('bunx', ['hardhat', 'node'], {
      cwd: path.join(__dirname, '..'),
      stdio: 'pipe',
      detached: true,
    })
    node.unref()
    if (node.stdout) node.stdout.on('data', (d) => process.stdout.write(d))
    if (node.stderr) node.stderr.on('data', (d) => process.stderr.write(d))
  }

  // 2. Wait for RPC
  await waitForRPC()
  console.log('Node is ready.')

  // 3. Deploy EAS + save partial manifest
  console.log('Running deploy_local_and_save...')
  const code1 = await run('bunx', ['hardhat', 'run', 'scripts/deploy_local_and_save.ts', '--network', 'localhost'], path.join(__dirname, '..'))
  if (code1 !== 0) {
    console.error('deploy_local_and_save failed with code', code1)
    process.exit(code1)
  }

  // 4. Deploy executor and mock
  console.log('Running deploy_executor_and_mock...')
  const code2 = await run('bunx', ['hardhat', 'run', 'scripts/deploy_executor_and_mock.ts', '--network', 'localhost'], path.join(__dirname, '..'))
  if (code2 !== 0) {
    console.error('deploy_executor_and_mock failed with code', code2)
    process.exit(code2)
  }

  // 5. Merge and write final manifest
  const easPart = JSON.parse(fs.readFileSync(LOCALHOST_EAS_JSON, 'utf-8'))
  const executorManifest = JSON.parse(fs.readFileSync(EXECUTOR_MOCK_JSON, 'utf-8'))
  const localhostExecutor = executorManifest['localhost'] || {}

  const manifest = {
    rpcUrl: RPC_URL,
    chainId: 1337,
    ...easPart,
    SeedProtocolExecutor: localhostExecutor.SeedProtocolExecutor,
    MockERC7579Account: localhostExecutor.MockERC7579Account,
  }

  fs.writeFileSync(LOCALHOST_JSON, JSON.stringify(manifest, null, 2), 'utf-8')
  console.log('Wrote', LOCALHOST_JSON)

  // Optionally remove partial
  try {
    fs.unlinkSync(LOCALHOST_EAS_JSON)
  } catch {
    // keep for debugging if delete fails
  }

  console.log('Setup complete.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
