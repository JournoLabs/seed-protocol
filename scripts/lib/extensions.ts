import { type Fragment, Interface } from "ethers";

/**
 * How the Seed contracts are registered on a thirdweb ManagedAccountFactory.
 *
 * Shared by the tests and the rollout scripts, so the selectors the tests
 * register are exactly the ones the rollout registers (docs/deploy-plan.md, step 2).
 */

/**
 * Selectors SeedProtocolExtension / SeedProtocolExtensionV2 are registered with.
 * `setEas` is deliberately absent: EAS is pinned at construction (access-control plan D3).
 */
export const SEED_EXTENSION_FUNCTIONS = ["multiPublish", "getEas"];

/** Selectors SeedExecutorRouterExtension is registered with. */
export const EXECUTOR_ROUTER_FUNCTIONS = [
  "installSeedExecutor",
  "uninstallSeedExecutor",
  "isModuleInstalled",
  "getSeedExecutor",
  "executeFromExecutor",
];

/**
 * Builds the `Extension` struct the thirdweb Router expects. Selectors are derived
 * from the canonical signature, which is what BaseRouter validates against.
 */
export function buildExtension(
  name: string,
  implementation: string,
  iface: Interface,
  functionNames: string[],
  metadataURI = "",
) {
  return {
    metadata: { name, metadataURI, implementation },
    functions: functionNames.map((fnName) => {
      const fragment = iface.getFunction(fnName);
      if (!fragment) throw new Error(`${name}: no function ${fnName}`);
      return { functionSelector: fragment.selector, functionSignature: fragment.format("sighash") };
    }),
  };
}

export type Extension = ReturnType<typeof buildExtension>;

/** Merges ABIs into one Interface, dropping duplicates (account + routed extensions share some). */
export function mergeInterfaces(...ifaces: Interface[]): Interface {
  const seen = new Set<string>();
  const fragments: Fragment[] = [];
  for (const iface of ifaces) {
    for (const fragment of iface.fragments) {
      if (!["function", "event", "error"].includes(fragment.type)) continue;
      const key = `${fragment.type}:${fragment.format("sighash")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fragments.push(fragment);
    }
  }
  return new Interface(fragments);
}
