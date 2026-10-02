const { ethers, upgrades } = require("hardhat");
const { deployEASWithSchemas } = require("./easFixture");

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

  const { schemaRegistry, ...easSetup } = await deployEASWithSchemas();
  const easAddress = await easSetup.eas.getAddress();

  const Extension = await ethers.getContractFactory("SeedProtocolExtension");
  const extension = await upgrades.deployProxy(Extension, [easAddress], {
    initializer: "initialize",
  });
  await extension.waitForDeployment();

  return {
    ...easSetup,
    extension,
    owner,
  };
}

module.exports = { extensionEASFixture };
