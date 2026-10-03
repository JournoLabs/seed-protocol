import { type Contract, ZeroAddress, getAddress, id } from "ethers";
import type { Extension } from "./extensions.js";

/**
 * Reading and changing a thirdweb ManagedAccountFactory's Router registry
 * (docs/deploy-plan.md, P4 and step 4).
 */

/** The factory role allowed to change its Router (ManagedAccountFactory._isAuthorizedCallToUpgrade). */
export const EXTENSION_ROLE = id("EXTENSION_ROLE");

export interface RegistryFunction {
  selector: string;
  signature: string;
}

export interface RegistryExtension {
  name: string;
  metadataURI: string;
  implementation: string;
  functions: RegistryFunction[];
}

/** Everything the factory routes, plus who may change it. Written to `routing-before.json`. */
export interface RoutingSnapshot {
  factory: string;
  chainId: string;
  blockNumber: number;
  extensionRoleHolders: string[];
  extensions: RegistryExtension[];
  /** selector → implementation, for every selector in `extensions` and every selector the rollout touches. */
  routing: Record<string, string>;
}

/** Names the Seed extension has been registered under (see the old get_extension_json.ts). */
const SEED_EXTENSION_NAMES = ["SeedProtocolExtension", "SeedProtocol"];
/** Functions only the Seed extension has ever had. */
const SEED_FUNCTION_NAMES = ["multiPublish", "setEas", "getEas"];

function functionName(signature: string): string {
  return signature.slice(0, signature.indexOf("("));
}

export async function readRegistry(factory: Contract): Promise<RegistryExtension[]> {
  const all = await factory.getAllExtensions();
  return all.map((ext: any) => ({
    name: ext.metadata.name,
    metadataURI: ext.metadata.metadataURI,
    implementation: getAddress(ext.metadata.implementation),
    functions: ext.functions.map((f: any) => ({ selector: f.functionSelector, signature: f.functionSignature })),
  }));
}

export async function readRoleHolders(factory: Contract, role: string): Promise<string[]> {
  const count = Number(await factory.getRoleMemberCount(role));
  const holders: string[] = [];
  for (let i = 0; i < count; i++) {
    const holder = await factory.getRoleMember(role, i);
    if (holder !== ZeroAddress) holders.push(getAddress(holder));
  }
  return holders;
}

export async function takeSnapshot(factory: Contract, extraSelectors: string[]): Promise<RoutingSnapshot> {
  const provider = factory.runner!.provider!;
  const blockNumber = await provider.getBlockNumber();
  const { chainId } = await provider.getNetwork();
  const extensions = await readRegistry(factory);
  const selectors = new Set([...extensions.flatMap((e) => e.functions.map((f) => f.selector)), ...extraSelectors]);
  const routing: Record<string, string> = {};
  for (const selector of [...selectors].sort()) {
    routing[selector] = getAddress(await factory.getImplementationForFunction(selector));
  }
  return {
    // Not getAddress(): ManagedAccountFactory has its own getAddress(address,bytes).
    factory: getAddress(factory.target as string),
    chainId: chainId.toString(),
    blockNumber,
    extensionRoleHolders: await readRoleHolders(factory, EXTENSION_ROLE),
    extensions,
    routing,
  };
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export type RouterAction =
  | { kind: "add"; extension: Extension }
  | { kind: "replace"; extension: Extension; replacing: RegistryExtension }
  | { kind: "unchanged"; extension: Extension };

function sameExtension(current: RegistryExtension, wanted: Extension): boolean {
  const selectors = (fns: { selector?: string; functionSelector?: string }[]) =>
    fns.map((f) => (f.selector ?? f.functionSelector)!.toLowerCase()).sort().join(",");
  return (
    current.implementation === getAddress(wanted.metadata.implementation) &&
    current.metadataURI === wanted.metadata.metadataURI &&
    selectors(current.functions) === selectors(wanted.functions)
  );
}

/** The registered extension(s) a new extension takes over from. */
function findPredecessors(registry: RegistryExtension[], names: string[], functionNames: string[]) {
  return registry.filter(
    (ext) => names.includes(ext.name) || ext.functions.some((f) => functionNames.includes(functionName(f.signature))),
  );
}

/**
 * Turns one wanted extension into an add, a replace or nothing.
 *
 * `replaceExtension` keys on the name, so the new struct takes the registered
 * name of whatever it replaces. Throws on anything that needs a human: more than
 * one predecessor, or a selector owned by an unrelated extension (which would make
 * the Router revert with "function impl already exists").
 */
function planOne(
  registry: RegistryExtension[],
  wanted: Extension,
  predecessors: RegistryExtension[],
): RouterAction {
  if (predecessors.length > 1) {
    throw new Error(
      `${wanted.metadata.name}: more than one registered extension to replace (${predecessors.map((p) => p.name).join(", ")}). Resolve by hand.`,
    );
  }
  const predecessor = predecessors[0];
  const extension: Extension = predecessor
    ? { ...wanted, metadata: { ...wanted.metadata, name: predecessor.name } }
    : wanted;

  for (const fn of extension.functions) {
    const owner = registry.find(
      (ext) => ext !== predecessor && ext.functions.some((f) => f.selector.toLowerCase() === fn.functionSelector.toLowerCase()),
    );
    if (owner) {
      throw new Error(`${wanted.metadata.name}: ${fn.functionSignature} is already routed to "${owner.name}" (${owner.implementation}).`);
    }
  }

  if (!predecessor) return { kind: "add", extension };
  if (sameExtension(predecessor, extension)) return { kind: "unchanged", extension };
  return { kind: "replace", extension, replacing: predecessor };
}

/** The rollout's Router changes (P7): the Seed extension, then the executor router. */
export function planRollout(
  registry: RegistryExtension[],
  seedExtension: Extension,
  executorRouterExtension: Extension,
): RouterAction[] {
  return [
    planOne(registry, seedExtension, findPredecessors(registry, SEED_EXTENSION_NAMES, SEED_FUNCTION_NAMES)),
    planOne(registry, executorRouterExtension, findPredecessors(registry, [executorRouterExtension.metadata.name], [])),
  ];
}

/** What every snapshotted selector should route to once `actions` are applied. */
export function expectedRouting(before: RoutingSnapshot, actions: RouterAction[]): Record<string, string> {
  const routing = { ...before.routing };
  for (const action of actions) {
    if (action.kind === "replace") {
      for (const fn of action.replacing.functions) routing[fn.selector] = ZeroAddress;
    }
    for (const fn of action.extension.functions) {
      routing[fn.functionSelector] = getAddress(action.extension.metadata.implementation);
    }
  }
  return routing;
}

/** Selectors whose routing differs from `expected`, as readable lines. */
export async function routingMismatches(factory: Contract, expected: Record<string, string>): Promise<string[]> {
  const mismatches: string[] = [];
  for (const [selector, implementation] of Object.entries(expected)) {
    const actual = getAddress(await factory.getImplementationForFunction(selector));
    if (actual !== implementation) mismatches.push(`${selector}: routes to ${actual}, expected ${implementation}`);
  }
  return mismatches;
}

/** One line per action, for the dry run and the calldata printout. */
export function describeAction(action: RouterAction): string {
  const { metadata, functions } = action.extension;
  const sigs = functions.map((f) => functionName(f.functionSignature)).join(", ");
  switch (action.kind) {
    case "add":
      return `addExtension("${metadata.name}") → ${metadata.implementation} [${sigs}]`;
    case "replace": {
      // A dropped function whose name lives on (a changed signature) is shown in full.
      const kept = new Set(functions.map((f) => functionName(f.functionSignature)));
      const dropped = action.replacing.functions
        .filter((old) => !functions.some((f) => f.functionSelector.toLowerCase() === old.selector.toLowerCase()))
        .map((f) => (kept.has(functionName(f.signature)) ? f.signature : functionName(f.signature)));
      return (
        `replaceExtension("${metadata.name}") ${action.replacing.implementation} → ${metadata.implementation} [${sigs}]` +
        (dropped.length ? `; stops routing [${dropped.join(", ")}]` : "")
      );
    }
    case "unchanged":
      return `"${metadata.name}" already registered as wanted; nothing to do`;
  }
}
