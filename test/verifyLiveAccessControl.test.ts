/**
 * scripts/verify_live_access_control.ts against the in-process ManagedAccount
 * stack, before and after the rollout, so the check can't silently rot.
 * See docs/deploy-plan.md (P5, step 5).
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect } from "chai";
import hre, { network } from "hardhat";
import { replaceExtension } from "../scripts/replace_extension.js";
import { verifyLiveAccessControl } from "../scripts/verify_live_access_control.js";
import { createRolloutFixtures } from "./fixtures/rolloutFixture.js";

const connection = await network.create();
const { networkHelpers } = connection;
const { oldRegistryFixture } = createRolloutFixtures(connection);

type Setup = Awaited<ReturnType<typeof oldRegistryFixture>>;

function verify(setup: Setup, factory = setup.factory.target as string) {
  return verifyLiveAccessControl(connection, hre, {
    account: setup.accountAddress,
    factory,
    eas: setup.easAddress,
    addresses: setup.addresses,
  });
}

describe("seed:verify-live", function () {
  let log: typeof console.log;
  beforeEach(function () {
    log = console.log;
    console.log = () => {};
  });
  afterEach(function () {
    console.log = log;
  });

  it("passes once the rollout has run", async function () {
    const setup = await networkHelpers.loadFixture(oldRegistryFixture);
    const snapshotFile = path.join(await mkdtemp(path.join(tmpdir(), "seed-routing-")), "routing-before.json");
    await replaceExtension(connection, { factory: setup.factory, extensions: setup.extensions, snapshotFile });

    expect(await verify(setup)).to.deep.equal([]);
  });

  it("fails before the rollout: setEas still routed, old implementation, no executor router", async function () {
    const setup = await networkHelpers.loadFixture(oldRegistryFixture);

    const failures = await verify(setup);

    expect(failures.some((f) => f.startsWith("setEas is not routed"))).to.equal(true);
    expect(failures.some((f) => f.startsWith("multiPublish routes to SeedProtocolExtension"))).to.equal(true);
    expect(failures.some((f) => f.startsWith("getSeedExecutor() returns"))).to.equal(true);
    // The old stand-in is the hardened contract, so these hold either way.
    expect(failures.some((f) => f.startsWith("multiPublish from a random address"))).to.equal(false);
    expect(failures.some((f) => f.startsWith("account belongs to the factory"))).to.equal(false);
  });

  it("fails when pointed at the wrong factory", async function () {
    const setup = await networkHelpers.loadFixture(oldRegistryFixture);
    const failures = await verify(setup, setup.stranger.address);
    expect(failures.some((f) => f.startsWith("account belongs to the factory"))).to.equal(true);
  });
});
