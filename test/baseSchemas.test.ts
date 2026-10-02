/**
 * The protocol's base schemas (schemas/base-schemas.json) and seed:ensure-schemas'
 * core. See docs/local-twin-plan.md (T4).
 */
import { expect } from "chai";
import type { Contract } from "ethers";
import { network } from "hardhat";
import { BASE_SCHEMAS, ensureBaseSchemas, schemaUid } from "../scripts/lib/schemas.js";

const connection = await network.create();
const { ethers, networkHelpers } = connection;

async function registryFixture() {
  const [signer] = await ethers.getSigners();
  const registry = (await ethers.deployContract("SchemaRegistry")) as unknown as Contract;
  return { registry: registry.connect(signer) as Contract };
}

describe("Base schemas", function () {
  it("lists the UIDs the SchemaRegistry computes (and the SDK hardcodes)", function () {
    for (const s of BASE_SCHEMAS) expect(schemaUid(s.schema, s.resolver, s.revocable), s.key).to.equal(s.uid);
    expect(BASE_SCHEMAS.find((s) => s.key === "version")?.uid).to.equal(
      "0x13c0fd59d69dbce40501a41f8b37768d26dd2e2bb0cad64615334d84f7b9bdf6",
    );
  });

  it("are all revocable with no resolver, so multiPublish's forced revocability works and UIDs match across chains", function () {
    for (const s of BASE_SCHEMAS) {
      expect(s.revocable, s.key).to.equal(true);
      expect(s.resolver, s.key).to.equal("0x0000000000000000000000000000000000000000");
    }
  });

  it("reports missing schemas without registering them by default", async function () {
    const { registry } = await networkHelpers.loadFixture(registryFixture);
    const results = await ensureBaseSchemas(registry);
    expect(results.map((r) => r.status)).to.deep.equal(BASE_SCHEMAS.map(() => "missing"));
  });

  it("registers what's missing, then is a no-op", async function () {
    const { registry } = await networkHelpers.loadFixture(registryFixture);
    // One already there, as on a chain where someone registered it first.
    await (await registry.register("bytes32 version", "0x0000000000000000000000000000000000000000", true)).wait();

    const first = await ensureBaseSchemas(registry, { register: true });
    expect(first.map((r) => [r.schema.key, r.status])).to.deep.equal([
      ["version", "registered"],
      ["schemaName", "registered now"],
      ["storageTransactionId", "registered now"],
    ]);
    for (const s of BASE_SCHEMAS) expect((await registry.getSchema(s.uid)).schema).to.equal(s.schema);

    const second = await ensureBaseSchemas(registry, { register: true });
    expect(second.map((r) => r.status)).to.deep.equal(BASE_SCHEMAS.map(() => "registered"));
  });
});
