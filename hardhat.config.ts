import 'dotenv/config'
import { configVariable, defineConfig } from 'hardhat/config'
import hardhatToolboxMochaEthers from '@nomicfoundation/hardhat-toolbox-mocha-ethers'

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
      chainId: 1337,
    },
    localhost: {
      type: 'http',
      url: 'http://127.0.0.1:8545',
      chainId: 1337,
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
  verify: {
    etherscan: {
      apiKey: configVariable('ETHERSCAN_API_KEY'),
    },
  },
})
