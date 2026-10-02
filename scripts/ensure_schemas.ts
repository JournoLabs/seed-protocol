import { readFile } from "node:fs/promises";
import path from "node:path";
import { Contract, Interface } from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import { ensureBaseSchemas } from "./lib/schemas.js";

/**
 * `hardhat seed:ensure-schemas`: makes sure the protocol's base schemas
 * (schemas/base-schemas.json) are registered on the network's SchemaRegistry,
 * registering any that are missing from the first signer. `--check-only` only reports,
 * and fails if any are missing (docs/local-twin-plan.md, T4).
 *
 * Registering a schema is permissionless and its UID doesn't depend on who registers it.
 */

interface Args {
  parameters: string;
  checkOnly: boolean;
}

export default async function ensureSchemasTask(args: Args, hre: HardhatRuntimeEnvironment) {
  const { ethers, networkName } = await hre.network.getOrCreate();
  const parametersFile = args.parameters || `ignition/parameters/${networkName}.json`;
  const parameters = JSON.parse(await readFile(path.resolve(hre.config.paths.root, parametersFile), "utf8"));
  const easAddress = parameters.SeedProtocol?.eas;
  if (!easAddress) throw new Error(`${parametersFile} has no SeedProtocol.eas`);

  const registry = await schemaRegistryFor(ethers.provider, hre, easAddress);
  const [signer] = args.checkOnly ? [] : await ethers.getSigners();
  console.log(`Network ${networkName}, SchemaRegistry ${registry.target}`);

  const results = await ensureBaseSchemas(signer ? (registry.connect(signer) as Contract) : registry, { register: !args.checkOnly });
  for (const { schema, status } of results) {
    console.log(`  ${status.padEnd(14)} ${schema.uid}  "${schema.schema}"`);
  }
  if (results.some((r) => r.status === "missing")) {
    console.log("Missing schemas; run without --check-only to register them.");
    process.exitCode = 1;
  }
}

/** The SchemaRegistry an EAS deployment uses. */
export async function schemaRegistryFor(
  provider: Awaited<ReturnType<HardhatRuntimeEnvironment["network"]["getOrCreate"]>>["ethers"]["provider"],
  hre: HardhatRuntimeEnvironment,
  easAddress: string,
): Promise<Contract> {
  const eas = new Contract(easAddress, ["function getSchemaRegistry() view returns (address)"], provider);
  const abi = new Interface((await hre.artifacts.readArtifact("SchemaRegistry")).abi);
  return new Contract(await eas.getSchemaRegistry(), abi, provider);
}
