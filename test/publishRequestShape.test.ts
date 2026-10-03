/**
 * SeedProtocolExtension and SeedProtocolExecutor take the same multiPublish request. Their
 * selectors match whenever the field *types* match, so a reordering of same-typed fields
 * (seedSchemaUid / versionUid) would pass any selector check and swap values silently.
 */
import { expect } from "chai";
import { Interface, type ParamType } from "ethers";
import hre from "hardhat";

/** Every field name and type, nested tuples included, in ABI order. */
function shape(param: ParamType): unknown {
  const inner = param.arrayChildren ?? param;
  return { name: param.name, type: param.type, components: inner.components?.map(shape) ?? null };
}

async function multiPublishInput(contract: string) {
  const iface = new Interface((await hre.artifacts.readArtifact(contract)).abi);
  const fn = iface.getFunction("multiPublish")!;
  return { selector: fn.selector, input: shape(fn.inputs[0]) };
}

describe("multiPublish request shape", function () {
  it("is identical on the extension and the executor, field by field", async function () {
    const extension = await multiPublishInput("SeedProtocolExtension");
    const executor = await multiPublishInput("SeedProtocolExecutor");
    expect(executor.input).to.deep.equal(extension.input);
    expect(executor.selector).to.equal(extension.selector).and.equal("0x2a29fadc");
  });
});
