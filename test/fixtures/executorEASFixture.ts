import type { HardhatEthers } from "@nomicfoundation/hardhat-ethers/types";
import { AbiCoder, ZeroAddress } from "ethers";

export const MODULE_TYPE_EXECUTOR = 2;

const SEED_SCHEMA = "bytes32 post";
const VERSION_SCHEMA = "bytes32 version";
const PROPERTY_SCHEMA = "string value";

/**
 * Returns a fixture that deploys SchemaRegistry and EAS, registers the
 * seed/version/property schemas, deploys SeedProtocolExecutor and
 * MockERC7579Account, and installs the executor on the account.
 *
 * Create it once per test file and pass the result to `loadFixture`, which
 * needs the same function each time to reuse its snapshot.
 */
export function createExecutorEASFixture({ ethers }: { ethers: HardhatEthers }) {
  return async function executorEASFixture() {
    const [owner, otherUser] = await ethers.getSigners();

    const schemaRegistry = await ethers.deployContract("SchemaRegistry");
    await schemaRegistry.waitForDeployment();

    const eas = await ethers.deployContract("EAS", [await schemaRegistry.getAddress()]);
    await eas.waitForDeployment();
    const easAddress = await eas.getAddress();

    const registerSchema = async (schemaString: string): Promise<string> => {
      const tx = await schemaRegistry.register(schemaString, ZeroAddress, true);
      const receipt = await tx.wait();
      for (const log of receipt?.logs ?? []) {
        const parsed = schemaRegistry.interface.parseLog(log);
        if (parsed?.name === "Registered") return parsed.args[0]; // uid is first indexed arg
      }
      throw new Error("Registered event not found");
    };

    const seedSchemaUid = await registerSchema(SEED_SCHEMA);
    const versionSchemaUid = await registerSchema(VERSION_SCHEMA);
    const propertySchemaUid = await registerSchema(PROPERTY_SCHEMA);

    const executor = await ethers.deployContract("SeedProtocolExecutor");
    await executor.waitForDeployment();

    const account = await ethers.deployContract("MockERC7579Account", [owner.address]);
    await account.waitForDeployment();

    const initData = AbiCoder.defaultAbiCoder().encode(["address"], [easAddress]);
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
  };
}
