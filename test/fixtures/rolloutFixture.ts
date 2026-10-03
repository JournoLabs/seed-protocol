/**
 * A factory in its pre-rollout state, plus a fresh deployment of what the rollout
 * registers. Shared by the replace_extension and verify_live_access_control tests
 * (docs/deploy-plan.md, steps 4–5).
 */
import { Contract, type FunctionFragment } from "ethers";
import hre from "hardhat";
import type { HardhatEthers } from "@nomicfoundation/hardhat-ethers/types";
import { RETIRED_SEED_FUNCTIONS, buildExtension } from "../../scripts/lib/extensions.js";
import { type SeedAddresses, buildSeedExtensions } from "../../scripts/lib/seedDeployment.js";
import { createManagedAccountFixtures } from "./managedAccountFixture.js";

export const SET_EAS = RETIRED_SEED_FUNCTIONS.getFunction("setEas")!.selector;
/** The string-publishLocalId multiPublish the pre-rollout extension routed. */
export const OLD_MULTI_PUBLISH = RETIRED_SEED_FUNCTIONS.getFunction("multiPublish")!.selector;

export function createRolloutFixtures(connection: { ethers: HardhatEthers }) {
  const { ethers } = connection;
  const { managedAccountFixture } = createManagedAccountFixtures(connection);

  /**
   * The managed-account stack, re-registered the way OP Sepolia had it before the
   * fix: "SeedProtocolExtension" routing the string-publishLocalId multiPublish,
   * getEas and setEas to an old implementation. Plus a fresh deployment of the contracts the rollout registers.
   */
  async function oldRegistryFixture() {
    const setup = await managedAccountFixture();
    const { factory, factoryAdmin, easAddress } = setup;

    // Stand-in for the old implementation; the Router doesn't check it has these functions.
    const oldImpl = await ethers.deployContract("SeedProtocolExtension", [easAddress]);
    await (
      await factory
        .connect(factoryAdmin)
        .replaceExtension(
          buildExtension(
            "SeedProtocolExtension",
            await oldImpl.getAddress(),
            RETIRED_SEED_FUNCTIONS,
            RETIRED_SEED_FUNCTIONS.fragments.map((f) => (f as FunctionFragment).format("sighash")),
          ),
        )
    ).wait();

    const seedProtocolExtension = await ethers.deployContract("SeedProtocolExtension", [easAddress]);
    const seedProtocolExecutor = await ethers.deployContract("SeedProtocolExecutor");
    const seedExecutorRouterExtension = await ethers.deployContract("SeedExecutorRouterExtension", [
      easAddress,
      await seedProtocolExecutor.getAddress(),
    ]);
    const addresses: SeedAddresses = {
      seedProtocolExtension: await seedProtocolExtension.getAddress(),
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
