const { ethers } = require("hardhat");

const MODULE_TYPE_EXECUTOR = 2;

const SEED_SCHEMA = "bytes32 post";
const VERSION_SCHEMA = "bytes32 version";
const PROPERTY_SCHEMA = "string value";

/**
 * Deploys SchemaRegistry, EAS, registers seed/version/property schemas,
 * deploys SeedProtocolExecutor and MockERC7579Account, installs the executor
 * on the account. For use with loadFixture in executor tests (in-process, no node).
 *
 * @returns {Promise<{
 *   eas: import("ethers").Contract,
 *   executor: import("ethers").Contract,
 *   account: import("ethers").Contract,
 *   owner: import("ethers").Signer,
 *   otherUser: import("ethers").Signer,
 *   seedSchemaUid: string,
 *   versionSchemaUid: string,
 *   propertySchemaUid: string,
 * }>}
 */
async function executorEASFixture() {
  const signers = await ethers.getSigners();
  const owner = signers[0];
  const otherUser = signers.length >= 2 ? signers[1] : new ethers.Wallet(ethers.Wallet.createRandom().privateKey, ethers.provider);
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

  const seedSchemaUid = await registerSchema(SEED_SCHEMA);
  const versionSchemaUid = await registerSchema(VERSION_SCHEMA);
  const propertySchemaUid = await registerSchema(PROPERTY_SCHEMA);

  const Executor = await ethers.getContractFactory("SeedProtocolExecutor");
  const executor = await Executor.deploy();
  await executor.waitForDeployment();

  const Account = await ethers.getContractFactory("MockERC7579Account");
  const account = await Account.deploy(owner.address);
  await account.waitForDeployment();

  const initData = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address"],
    [easAddress]
  );
  await account.installModule(MODULE_TYPE_EXECUTOR, await executor.getAddress(), initData);

  return {
    eas,
    executor,
    account,
    owner,
    otherUser,
    seedSchemaUid,
    versionSchemaUid,
    propertySchemaUid,
  };
}

module.exports = { executorEASFixture, MODULE_TYPE_EXECUTOR };
