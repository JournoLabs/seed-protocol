import 'dotenv/config'
import { configVariable, defineConfig } from 'hardhat/config'
import hardhatToolboxMochaEthers from '@nomicfoundation/hardhat-toolbox-mocha-ethers'
import { createxSalt } from './scripts/lib/createxSalt.js'

// Deploys go through CreateX with a sender-guarded salt (docs/deploy-plan.md, P2).
// Only this address gets the canonical Seed addresses; it must be the key that runs
// `ignition deploy` on public networks (input I7). Today that's DEV_KEY.
const SEED_DEPLOYER = '0x00467fe2608Dff148C83009927E4e7234Bc4D84B'

export default defineConfig({
  plugins: [hardhatToolboxMochaEthers],
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
      accounts: [configVariable('LOCALHOST_TESTING_KEY')],
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
