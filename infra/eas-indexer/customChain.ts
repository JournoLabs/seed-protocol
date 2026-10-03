// Seed overlay: one extra chain config from the environment, so a local chain can be
// indexed without editing upstream's chainConfigs.ts. EAS_CUSTOM_CHAIN is the JSON of one
// EASChainConfig (chainId, chainName, subdomain, version, contractAddress,
// schemaRegistryAddress, etherscanURL, contractStartBlock, rpcProvider).
import type { EASChainConfig } from "./chainConfigs";

export const customChainConfigs: EASChainConfig[] = process.env.EAS_CUSTOM_CHAIN
  ? [JSON.parse(process.env.EAS_CUSTOM_CHAIN)]
  : [];
