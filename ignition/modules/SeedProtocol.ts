import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * The Seed Protocol contracts the ManagedAccountFactory routes to (docs/deploy-plan.md, step 1).
 *
 * Deploy with `--strategy create2` so addresses are deterministic (P2). `eas` is the
 * only parameter; on OP Stack chains it's the 0x4200…0021 predeploy.
 */
export default buildModule("SeedProtocol", (m) => {
  const eas = m.getParameter<string>("eas");

  const seedProtocolExtension = m.contract("SeedProtocolExtension", [eas]);
  const seedProtocolExtensionV2 = m.contract("SeedProtocolExtensionV2", [eas]);
  const seedProtocolExecutor = m.contract("SeedProtocolExecutor", []);
  const seedExecutorRouterExtension = m.contract("SeedExecutorRouterExtension", [eas, seedProtocolExecutor]);

  return { seedProtocolExtension, seedProtocolExtensionV2, seedProtocolExecutor, seedExecutorRouterExtension };
});
