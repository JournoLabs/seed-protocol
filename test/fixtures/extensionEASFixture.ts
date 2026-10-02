import type { createManagedAccountFixtures } from "./managedAccountFixture.js";

/**
 * SeedProtocolExtension routed through a real thirdweb ManagedAccount, for gas
 * benchmarks. `extension` is the account (connected as its admin), so measured
 * gas includes the Router + delegatecall overhead users actually pay.
 *
 * Pass the helpers from `createManagedAccountFixtures(connection)`; create the
 * result once per test file so `loadFixture` can reuse its snapshot.
 */
export function createExtensionEASFixture({
  deployManagedAccountStack,
}: ReturnType<typeof createManagedAccountFixtures>) {
  return async function extensionEASFixture() {
    const setup = await deployManagedAccountStack();
    return {
      ...setup,
      extension: setup.account,
      owner: setup.accountAdmin,
    };
  };
}
