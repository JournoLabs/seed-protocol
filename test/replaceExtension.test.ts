/**
 * scripts/replace_extension.ts against the in-process ManagedAccount stack,
 * starting from a factory that routes the old Seed selectors (setEas included).
 * See docs/deploy-plan.md (P4, step 4).
 */
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect } from "chai";
import { Contract, ZeroAddress } from "ethers";
import { network } from "hardhat";
import type { RoutingSnapshot } from "../scripts/lib/routing.js";
import { replaceExtension } from "../scripts/replace_extension.js";
import { SET_EAS, createRolloutFixtures } from "./fixtures/rolloutFixture.js";

const connection = await network.create();
const { networkHelpers } = connection;
const { oldRegistryFixture } = createRolloutFixtures(connection);

async function newSnapshotFile() {
  return path.join(await mkdtemp(path.join(tmpdir(), "seed-routing-")), "routing-before.json");
}

describe("seed:replace-extension", function () {
  let log: typeof console.log;
  beforeEach(function () {
    log = console.log;
    console.log = () => {};
  });
  afterEach(function () {
    console.log = log;
    process.exitCode = undefined;
  });

  it("replaces the old Seed extension, adds the executor router, and records the old routing", async function () {
    const { factory, extensions, oldImpl } = await networkHelpers.loadFixture(oldRegistryFixture);
    const snapshotFile = await newSnapshotFile();

    const { sent } = await replaceExtension(connection, { factory, extensions, snapshotFile });
    expect(sent).to.equal(true);

    const seedImpl = extensions.seedProtocolExtension.metadata.implementation;
    const routerImpl = extensions.seedExecutorRouterExtension.metadata.implementation;
    for (const fn of extensions.seedProtocolExtension.functions) {
      expect(await factory.getImplementationForFunction(fn.functionSelector), fn.functionSignature).to.equal(seedImpl);
    }
    for (const fn of extensions.seedExecutorRouterExtension.functions) {
      expect(await factory.getImplementationForFunction(fn.functionSelector), fn.functionSignature).to.equal(routerImpl);
    }
    expect(await factory.getImplementationForFunction(SET_EAS)).to.equal(ZeroAddress);

    const before: RoutingSnapshot = JSON.parse(await readFile(snapshotFile, "utf8"));
    expect(before.routing[SET_EAS]).to.equal(oldImpl);
    expect(before.extensions.find((e) => e.name === "SeedProtocolExtension")?.implementation).to.equal(oldImpl);
  });

  it("is a no-op on a second run, and --check-only passes", async function () {
    const { factory, extensions } = await networkHelpers.loadFixture(oldRegistryFixture);
    const snapshotFile = await newSnapshotFile();
    await replaceExtension(connection, { factory, extensions, snapshotFile });
    const first = await readFile(snapshotFile, "utf8");

    expect((await replaceExtension(connection, { factory, extensions, snapshotFile })).sent).to.equal(false);
    await replaceExtension(connection, { factory, extensions, snapshotFile, checkOnly: true });
    // The pre-rollout snapshot is the rollback record, so later runs never overwrite it.
    expect(await readFile(snapshotFile, "utf8")).to.equal(first);
  });

  it("--dry-run sends and writes nothing", async function () {
    const { factory, extensions, oldImpl } = await networkHelpers.loadFixture(oldRegistryFixture);
    const snapshotFile = await newSnapshotFile();

    expect((await replaceExtension(connection, { factory, extensions, snapshotFile, dryRun: true })).sent).to.equal(false);
    expect(await factory.getImplementationForFunction(SET_EAS)).to.equal(oldImpl);
    expect(existsSync(snapshotFile)).to.equal(false);
  });

  it("prints the call instead of sending when the signer lacks EXTENSION_ROLE", async function () {
    const { factory, extensions, oldImpl, stranger } = await networkHelpers.loadFixture(oldRegistryFixture);
    const snapshotFile = await newSnapshotFile();
    const lines: string[] = [];
    console.log = (...args: unknown[]) => lines.push(args.join(" "));

    const { sent } = await replaceExtension(connection, { factory, extensions, snapshotFile, impersonate: stranger.address });

    expect(sent).to.equal(false);
    expect(process.exitCode).to.equal(1);
    expect(await factory.getImplementationForFunction(SET_EAS)).to.equal(oldImpl);
    expect(existsSync(snapshotFile), "snapshot is still recorded for the hand-submitted call").to.equal(true);
    const data = lines.find((l) => l.trim().startsWith("data:"))!.trim().slice("data:".length).trim();
    expect(factory.interface.parseTransaction({ data })?.name).to.equal("multicall");
  });

  it("refuses when an unrelated extension already routes one of the new selectors", async function () {
    const { factory, factoryAdmin, extensions, oldImpl } = await networkHelpers.loadFixture(oldRegistryFixture);
    const getSeedExecutor = extensions.seedExecutorRouterExtension.functions.find((f) =>
      f.functionSignature.startsWith("getSeedExecutor"),
    )!;
    await (
      await (factory.connect(factoryAdmin) as Contract).addExtension({
        metadata: { name: "Squatter", metadataURI: "", implementation: oldImpl },
        functions: [getSeedExecutor],
      })
    ).wait();

    let error: Error | undefined;
    try {
      await replaceExtension(connection, { factory, extensions, snapshotFile: await newSnapshotFile() });
    } catch (e) {
      error = e as Error;
    }
    expect(error?.message).to.match(/getSeedExecutor\(\) is already routed to "Squatter"/);
  });
});
