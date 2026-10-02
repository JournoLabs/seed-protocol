/**
 * A factory in its pre-rollout state, plus a fresh deployment of what the rollout
 * registers. Shared by the replace_extension and verify_live_access_control tests
 * (docs/deploy-plan.md, steps 4–5).
 */
import { Contract, Interface } from "ethers";
import hre from "hardhat";
import type { HardhatEthers } from "@nomicfoundation/hardhat-ethers/types";
import { SEED_EXTENSION_FUNCTIONS, buildExtension, mergeInterfaces } from "../../scripts/lib/extensions.js";
import { type SeedAddresses, buildSeedExtensions } from "../../scripts/lib/seedDeployment.js";
import { createManagedAccountFixtures } from "./managedAccountFixture.js";

export const LEGACY_SET_EAS = new Interface(["function setEas(address)"]);
export const SET_EAS = LEGACY_SET_EAS.getFunction("setEas")!.selector;

export function createRolloutFixtures(connection: { ethers: HardhatEthers }) {
  const { ethers } = connection;
  const { managedAccountFixture } = createManagedAccountFixtures(connection);

  /**
   * The managed-account stack, re-registered the way OP Sepolia had it before the
   * fix: "SeedProtocolExtension" routing multiPublish, getEas and setEas to an old
   * implementation. Plus a fresh deployment of the contracts the rollout registers.
   */
  async function oldRegistryFixture() {
    const setup = await managedAccountFixture();
    const { factory, factoryAdmin, easAddress } = setup;

    // Stand-in for the old implementation; the Router doesn't check it has setEas.
    const oldImpl = await ethers.deployContract("SeedProtocolExtension", [easAddress]);
    const oldAbi = mergeInterfaces(oldImpl.interface, LEGACY_SET_EAS);
    await (
      await factory
        .connect(factoryAdmin)
        .replaceExtension(
          buildExtension("SeedProtocolExtension", await oldImpl.getAddress(), oldAbi, [...SEED_EXTENSION_FUNCTIONS, "setEas"]),
        )
    ).wait();

    const seedProtocolExtension = await ethers.deployContract("SeedProtocolExtension", [easAddress]);
    const seedProtocolExtensionV2 = await ethers.deployContract("SeedProtocolExtensionV2", [easAddress]);
    const seedProtocolExecutor = await ethers.deployContract("SeedProtocolExecutor");
    const seedExecutorRouterExtension = await ethers.deployContract("SeedExecutorRouterExtension", [
      easAddress,
      await seedProtocolExecutor.getAddress(),
    ]);
    const addresses: SeedAddresses = {
      seedProtocolExtension: await seedProtocolExtension.getAddress(),
      seedProtocolExtensionV2: await seedProtocolExtensionV2.getAddress(),
      seedProtocolExecutor: await seedProtocolExecutor.getAddress(),
      seedExecutorRouterExtension: await seedExecutorRouterExtension.getAddress(),
    };
    const extensions = await buildSeedExtensions(hre, addresses);

    // The script takes a plain ethers Contract, not the TypeChain type.
    const plainFactory = new Contract(factory.target, factory.interface, ethers.provider);
    return { ...setup, factory: plainFactory, oldImpl: await oldImpl.getAddress(), addresses, extensions };
  }

  return { oldRegistryFixture };
}
