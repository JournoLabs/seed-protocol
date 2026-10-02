import type { HardhatEthers } from "@nomicfoundation/hardhat-ethers/types";
import { ZeroAddress } from "ethers";

const SEED_SCHEMA_1 = "bytes32 post";
const SEED_SCHEMA_2 = "bytes32 image";
const SEED_SCHEMA_3 = "bytes32 comment";
const VERSION_SCHEMA = "bytes32 version";
const PROPERTY_SCHEMA_1 = "string value";
const PROPERTY_SCHEMA_2 = "bytes32 ref";
const PROPERTY_SCHEMA_3 = "string metadata";

/**
 * Deploys SchemaRegistry + EAS and registers the seed/version/property schemas
 * used across the test suites.
 */
export async function deployEASWithSchemas(ethers: HardhatEthers) {
  const schemaRegistry = await ethers.deployContract("SchemaRegistry");
  await schemaRegistry.waitForDeployment();

  const eas = await ethers.deployContract("EAS", [await schemaRegistry.getAddress()]);
  await eas.waitForDeployment();

  const registerSchema = async (schemaString: string): Promise<string> => {
    const tx = await schemaRegistry.register(schemaString, ZeroAddress, true);
    const receipt = await tx.wait();
    for (const log of receipt?.logs ?? []) {
      const parsed = schemaRegistry.interface.parseLog(log);
      if (parsed?.name === "Registered") return parsed.args[0]; // uid is first indexed arg
    }
    throw new Error("Registered event not found");
  };

  const seedSchemaUid1 = await registerSchema(SEED_SCHEMA_1);
  const seedSchemaUid2 = await registerSchema(SEED_SCHEMA_2);
  const seedSchemaUid3 = await registerSchema(SEED_SCHEMA_3);
  const versionSchemaUid = await registerSchema(VERSION_SCHEMA);
  const propertySchemaUid1 = await registerSchema(PROPERTY_SCHEMA_1);
  const propertySchemaUid2 = await registerSchema(PROPERTY_SCHEMA_2);
  const propertySchemaUid3 = await registerSchema(PROPERTY_SCHEMA_3);

  return {
    eas,
    schemaRegistry,
    seedSchemaUid: seedSchemaUid1,
    seedSchemaUid1,
    seedSchemaUid2,
    seedSchemaUid3,
    versionSchemaUid,
    propertySchemaUid: propertySchemaUid1,
    propertySchemaUid1,
    propertySchemaUid2,
    propertySchemaUid3,
  };
}

export type EASSetup = Awaited<ReturnType<typeof deployEASWithSchemas>>;
