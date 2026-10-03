import { readFile } from "node:fs/promises";
import path from "node:path";
import { Interface, getAddress } from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import { EXECUTOR_ROUTER_FUNCTIONS, type Extension, SEED_EXTENSION_FUNCTIONS, buildExtension } from "./extensions.js";

/** Addresses from an Ignition deployment of ignition/modules/SeedProtocol.ts. */
export interface SeedAddresses {
  seedProtocolExtension: string;
  seedProtocolExecutor: string;
  seedExecutorRouterExtension: string;
}

const MODULE_ID = "SeedProtocol";

/** Ignition's default deployment id for a chain. */
export function defaultDeploymentId(chainId: bigint | number): string {
  return `chain-${chainId}`;
}

/** Reads `ignition/deployments/<id>/deployed_addresses.json`, the one place deployed addresses live (P1). */
export async function loadSeedAddresses(hre: HardhatRuntimeEnvironment, deploymentId: string): Promise<SeedAddresses> {
  const file = path.join(hre.config.paths.ignition, "deployments", deploymentId, "deployed_addresses.json");
  let deployed: Record<string, string>;
  try {
    deployed = JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    throw new Error(`No Ignition deployment at ${file}. Deploy ignition/modules/SeedProtocol.ts first.`, { cause: e });
  }
  const get = (name: string) => {
    const address = deployed[`${MODULE_ID}#${name}`];
    if (!address) throw new Error(`${file} has no ${MODULE_ID}#${name}`);
    return getAddress(address);
  };
  return {
    seedProtocolExtension: get("SeedProtocolExtension"),
    seedProtocolExecutor: get("SeedProtocolExecutor"),
    seedExecutorRouterExtension: get("SeedExecutorRouterExtension"),
  };
}

/** Rollout settings kept next to the module parameters, under a `SeedRollout` key. */
export interface RolloutParameters {
  /** The ManagedAccountFactory whose Router the rollout changes (input I1). */
  factory: string;
}

export async function loadRolloutParameters(hre: HardhatRuntimeEnvironment, file: string): Promise<RolloutParameters> {
  const parameters = JSON.parse(await readFile(path.resolve(hre.config.paths.root, file), "utf8"));
  const factory = parameters.SeedRollout?.factory;
  if (!factory) throw new Error(`${file} has no SeedRollout.factory (the ManagedAccountFactory address, input I1)`);
  return { factory: getAddress(factory) };
}

/** The `Extension` structs the factory gets (P7): the Seed extension and the executor router. */
export async function buildSeedExtensions(hre: HardhatRuntimeEnvironment, addresses: SeedAddresses, metadataURI = "") {
  const iface = async (name: string) => new Interface((await hre.artifacts.readArtifact(name)).abi);
  return {
    seedProtocolExtension: buildExtension(
      "SeedProtocolExtension",
      addresses.seedProtocolExtension,
      await iface("SeedProtocolExtension"),
      SEED_EXTENSION_FUNCTIONS,
      metadataURI,
    ),
    seedExecutorRouterExtension: buildExtension(
      "SeedExecutorRouterExtension",
      addresses.seedExecutorRouterExtension,
      await iface("SeedExecutorRouterExtension"),
      EXECUTOR_ROUTER_FUNCTIONS,
      metadataURI,
    ),
  } satisfies Record<string, Extension>;
}
