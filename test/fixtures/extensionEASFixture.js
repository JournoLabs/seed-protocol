const { deployManagedAccountStack } = require("./managedAccountFixture");

/**
 * SeedProtocolExtension routed through a real thirdweb ManagedAccount, for gas
 * benchmarks. `extension` is the account (connected as its admin), so measured
 * gas includes the Router + delegatecall overhead users actually pay.
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
  const setup = await deployManagedAccountStack();
  return {
    ...setup,
    extension: setup.account,
    owner: setup.accountAdmin,
  };
}

module.exports = { extensionEASFixture };
