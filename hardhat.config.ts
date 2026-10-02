import 'dotenv/config'
import { configVariable, defineConfig, task } from 'hardhat/config'
import hardhatToolboxMochaEthers from '@nomicfoundation/hardhat-toolbox-mocha-ethers'
import { SEED_DEPLOYER, SEED_SALT_LABEL, createxSalt } from './scripts/lib/createxSalt.js'

// Rollout scripts (docs/deploy-plan.md). Tasks rather than `hardhat run` so they take flags.
const predictAddresses = task('seed:predict-addresses', 'Where create2 will deploy SeedProtocol, and whether it would succeed (read-only)')
  .addOption({ name: 'parameters', description: 'Parameters file (default: ignition/parameters/<network>.json)', defaultValue: '' })
  .addOption({ name: 'deployer', description: 'Deployer address (default: the Seed deployer the salt is guarded for)', defaultValue: '' })
  .setAction(() => import('./scripts/predict_addresses.js'))
  .build()

const extensionPayload = task('seed:extension-payload', 'Print the Router Extension structs for a SeedProtocol deployment')
  .addOption({ name: 'deploymentId', description: 'Ignition deployment id (default: chain-<chainId>)', defaultValue: '' })
  .addOption({ name: 'metadataUri', description: 'metadataURI for every extension (input I5)', defaultValue: '' })
  .setAction(() => import('./scripts/build_extension_payload.js'))
  .build()

const replaceExtension = task('seed:replace-extension', "Point the ManagedAccountFactory's Router at a SeedProtocol deployment")
  .addOption({ name: 'parameters', description: 'File with SeedRollout.factory (default: ignition/parameters/<network>.json)', defaultValue: '' })
  .addOption({ name: 'deploymentId', description: 'Ignition deployment id (default: chain-<chainId>)', defaultValue: '' })
  .addOption({ name: 'metadataUri', description: 'metadataURI for every extension (input I5)', defaultValue: '' })
  .addOption({ name: 'impersonate', description: 'Send as this EXTENSION_ROLE holder, or "auto" for the first one (simulated networks only)', defaultValue: '' })
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
  tasks: [predictAddresses, extensionPayload, replaceExtension, verifyLive, publishSmoke],
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
    // A running `hardhat node`, local or forking (the rehearsals). No chainId pin,
    // so it works for both; accounts are the node's own unlocked ones.
    localhost: {
      type: 'http',
      url: 'http://127.0.0.1:8545',
    },
    // OP Sepolia state, simulated. rehearse:op-sepolia runs `hardhat node` on it.
    optimism_sepolia_fork: {
      type: 'edr-simulated',
      chainType: 'op',
      chainId: 11155420,
      forking: {
        url: configVariable('OPTIMISM_SEPOLIA_RPC_URL'),
      },
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
        // Deploys go through CreateX with a sender-guarded salt (docs/deploy-plan.md, P2).
        salt: createxSalt(SEED_DEPLOYER, SEED_SALT_LABEL),
      },
    },
  },
  verify: {
    etherscan: {
      apiKey: configVariable('ETHERSCAN_API_KEY'),
    },
  },
})
