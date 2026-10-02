import 'dotenv/config'
import { configVariable, defineConfig, task } from 'hardhat/config'
import hardhatToolboxMochaEthers from '@nomicfoundation/hardhat-toolbox-mocha-ethers'
import { createxSalt } from './scripts/lib/createxSalt.js'

// Deploys go through CreateX with a sender-guarded salt (docs/deploy-plan.md, P2).
// Only this address gets the canonical Seed addresses; it must be the key that runs
// `ignition deploy` on public networks (input I7). Today that's DEV_KEY.
const SEED_DEPLOYER = '0x00467fe2608Dff148C83009927E4e7234Bc4D84B'

// Rollout scripts (docs/deploy-plan.md). Tasks rather than `hardhat run` so they take flags.
const extensionPayload = task('seed:extension-payload', 'Print the Router Extension structs for a SeedProtocol deployment')
  .addOption({ name: 'deploymentId', description: 'Ignition deployment id (default: chain-<chainId>)', defaultValue: '' })
  .addOption({ name: 'metadataUri', description: 'metadataURI for every extension (input I5)', defaultValue: '' })
  .setAction(() => import('./scripts/build_extension_payload.js'))
  .build()

const replaceExtension = task('seed:replace-extension', "Point the ManagedAccountFactory's Router at a SeedProtocol deployment")
  .addOption({ name: 'parameters', description: 'File with SeedRollout.factory (default: ignition/parameters/<network>.json)', defaultValue: '' })
  .addOption({ name: 'deploymentId', description: 'Ignition deployment id (default: chain-<chainId>)', defaultValue: '' })
  .addOption({ name: 'metadataUri', description: 'metadataURI for every extension (input I5)', defaultValue: '' })
  .addOption({ name: 'impersonate', description: 'Send as this EXTENSION_ROLE holder (simulated networks only)', defaultValue: '' })
  .addFlag({ name: 'dryRun', description: 'Print the planned changes and calldata; write and send nothing' })
  .addFlag({ name: 'checkOnly', description: 'Only read the Router back against routing-before.json' })
  .setAction(() => import('./scripts/replace_extension.js'))
  .build()

const verifyLive = task('seed:verify-live', 'Static checks of a live account against a SeedProtocol deployment')
  .addOption({ name: 'account', description: 'A ManagedAccount on this network (input I3)', defaultValue: '' })
  .addOption({ name: 'parameters', description: 'Parameters file (default: ignition/parameters/<network>.json)', defaultValue: '' })
  .addOption({ name: 'deploymentId', description: 'Ignition deployment id (default: chain-<chainId>)', defaultValue: '' })
  .setAction(() => import('./scripts/verify_live_access_control.js'))
  .build()

const publishSmoke = task('seed:publish-smoke', 'Admin and session-key publishes through the live routing (simulated networks only)')
  .addOption({ name: 'parameters', description: 'Parameters file (default: ignition/parameters/<network>.json)', defaultValue: '' })
  .addOption({ name: 'account', description: 'Also publish on this existing account…', defaultValue: '' })
  .addOption({ name: 'impersonateAdmin', description: '…as this admin of it', defaultValue: '' })
  .setAction(() => import('./scripts/publish_smoke.js'))
  .build()

export default defineConfig({
  plugins: [hardhatToolboxMochaEthers],
  tasks: [extensionPayload, replaceExtension, verifyLive, publishSmoke],
  paths: {
    sources: './contracts',
  },
  solidity: {
    // Matches the Hardhat 2 build exactly (see docs/hardhat3-migration-plan.md, H4).
    version: '0.8.27',
    settings: {
      evmVersion: 'paris',
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
    // Hardhat 3 only emits artifacts for project sources. Tests and scripts
    // deploy these npm contracts by name, so build them explicitly.
    npmFilesToBuild: [
      '@ethereum-attestation-service/eas-contracts/contracts/EAS.sol',
      '@ethereum-attestation-service/eas-contracts/contracts/SchemaRegistry.sol',
      '@thirdweb-dev/contracts/prebuilts/account/managed/ManagedAccountFactory.sol',
      '@thirdweb-dev/contracts/prebuilts/account/managed/ManagedAccount.sol',
      '@thirdweb-dev/contracts/prebuilts/account/utils/AccountExtension.sol',
      '@thirdweb-dev/contracts/prebuilts/account/utils/Entrypoint.sol',
    ],
  },
  networks: {
    default: {
      type: 'edr-simulated',
      chainType: 'l1',
      // Hardhat's default. Ignition's create2 strategy only bootstraps CreateX on 31337.
      chainId: 31337,
    },
    localhost: {
      type: 'http',
      url: 'http://127.0.0.1:8545',
      chainId: 31337,
      // `hardhat node`'s own unlocked accounts (rehearse:local).
    },
    optimism_sepolia: {
      type: 'http',
      chainType: 'op',
      url: configVariable('OPTIMISM_SEPOLIA_RPC_URL'),
      chainId: 11155420,
      accounts: [configVariable('DEV_KEY')],
    },
  },
  ignition: {
    strategyConfig: {
      create2: {
        salt: createxSalt(SEED_DEPLOYER, 'seed-v1'),
      },
    },
  },
  verify: {
    etherscan: {
      apiKey: configVariable('ETHERSCAN_API_KEY'),
    },
  },
})
