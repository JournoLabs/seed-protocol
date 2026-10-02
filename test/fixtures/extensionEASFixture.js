const { ethers, upgrades } = require("hardhat");

const SEED_SCHEMA_1 = "bytes32 post";
const SEED_SCHEMA_2 = "bytes32 image";
const SEED_SCHEMA_3 = "bytes32 comment";
const VERSION_SCHEMA = "bytes32 version";
const PROPERTY_SCHEMA_1 = "string value";
const PROPERTY_SCHEMA_2 = "bytes32 ref";
const PROPERTY_SCHEMA_3 = "string metadata";

/**
 * Deploys SchemaRegistry, EAS, registers seed/version/property schemas,
 * deploys SeedProtocolExtension via proxy. For use with gas benchmarks and
 * extension tests (in-process, no node).
 *
 * @returns {Promise<{
 *   eas: import("ethers").Contract,
 *   extension: import("ethers").Contract,
 *   owner: import("ethers").Signer,
 *   seedSchemaUid: string,
 *   seedSchemaUid1: string,
 *   seedSchemaUid2: string,
 *   seedSchemaUid3: string,
 *   versionSchemaUid: string,
 *   propertySchemaUid: string,
 *   propertySchemaUid1: string,
 *   propertySchemaUid2: string,
 *   propertySchemaUid3: string,
 * }>}
 */
async function extensionEASFixture() {
  const signers = await ethers.getSigners();
  const owner = signers[0];
  const zeroAddress = ethers.ZeroAddress;

  const SchemaRegistry = await ethers.getContractFactory("SchemaRegistry");
  const schemaRegistry = await SchemaRegistry.deploy();
  await schemaRegistry.waitForDeployment();
  const schemaRegistryAddress = await schemaRegistry.getAddress();

  const EAS = await ethers.getContractFactory("EAS");
  const eas = await EAS.deploy(schemaRegistryAddress);
  await eas.waitForDeployment();
  const easAddress = await eas.getAddress();

  const registerSchema = async (schemaString) => {
    const tx = await schemaRegistry.register(schemaString, zeroAddress, true);
    const receipt = await tx.wait();
    const event = receipt?.logs?.find((log) => {
      try {
        const parsed = schemaRegistry.interface.parseLog({ topics: log.topics, data: log.data });
        return parsed?.name === "Registered";
      } catch {
        return false;
      }
    });
    if (event) {
      const parsed = schemaRegistry.interface.parseLog({ topics: event.topics, data: event.data });
      return parsed.args[0]; // uid is first indexed arg
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

  const Extension = await ethers.getContractFactory("SeedProtocolExtension");
  const extension = await upgrades.deployProxy(Extension, [easAddress], {
    initializer: "initialize",
  });
  await extension.waitForDeployment();

  return {
    eas,
    extension,
    owner,
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

module.exports = { extensionEASFixture };
