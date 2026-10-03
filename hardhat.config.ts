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

const ensureSchemas = task('seed:ensure-schemas', "Register the protocol's base EAS schemas where missing")
  .addOption({ name: 'parameters', description: 'Parameters file with SeedProtocol.eas (default: ignition/parameters/<network>.json)', defaultValue: '' })
  .addFlag({ name: 'checkOnly', description: 'Only report; fail if any are missing' })
  .setAction(() => import('./scripts/ensure_schemas.js'))
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

const debugPublish = task('seed:debug-publish', 'Simulate multiPublish on an account and decode the revert (read-only)')
  .addOption({ name: 'account', description: 'The account to call', defaultValue: '' })
  .addOption({ name: 'payload', description: 'JSON file with the publish requests', defaultValue: '' })
  .addOption({ name: 'from', description: 'Caller, normally an account admin (default: first signer)', defaultValue: '' })
  .setAction(() => import('./scripts/debug_multi_publish.js'))
  .build()

const explainUserOp = task('seed:explain-userop', 'Explain why a UserOp in a handleOps transaction failed (read-only)')
  .addOption({ name: 'tx', description: 'The handleOps transaction hash', defaultValue: '' })
  .setAction(() => import('./scripts/explain_userop.js'))
  .build()

export default defineConfig({
  plugins: [hardhatToolboxMochaEthers],
  tasks: [predictAddresses, ensureSchemas, extensionPayload, replaceExtension, verifyLive, publishSmoke, debugPublish, explainUserOp],
  paths: {
    sources: './contracts',
  },
  solidity: {
    // Matches the Hardhat 2 build exactly (see docs/hardhat3-migration-plan.md, H4).
    // Both profiles are spelled out and identical. From the short form, Hardhat derives
    // `production` (what `ignition deploy` builds on live networks) with only the
    // optimizer settings, which drops evmVersion (so `cancun`), and with `isolated: true`,
    // which changes the metadata hash. Either one moves the CREATE2 addresses away from
    // the tested build and seed:predict-addresses.
    profiles: {
      default: { version: '0.8.27', settings: { evmVersion: 'paris', optimizer: { enabled: true, runs: 200 } } },
      production: { version: '0.8.27', isolated: false, settings: { evmVersion: 'paris', optimizer: { enabled: true, runs: 200 } } },
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
    // OP Sepolia state under its own chain id, so a transaction that misses the local
    // config can't be valid on the real chain (docs/local-twin-plan.md, T1).
    // `bun run twin:up` pins the block with TWIN_FORK_BLOCK.
    op_sepolia_twin: {
      type: 'edr-simulated',
      chainType: 'op',
      chainId: 31337,
      forking: {
        url: configVariable('OPTIMISM_SEPOLIA_RPC_URL'),
        ...(process.env.TWIN_FORK_BLOCK ? { blockNumber: BigInt(process.env.TWIN_FORK_BLOCK) } : {}),
      },
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
