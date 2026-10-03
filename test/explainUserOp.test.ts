/**
 * seed:explain-userop against real UserOps on the ManagedAccount stack: one that runs out of
 * gas (the case thirdweb reports only as "UserOp failed at txHash"), one that reverts with a
 * Seed error, and one that succeeds.
 */
import { expect } from "chai";
import { network } from "hardhat";
import { explainUserOps } from "../scripts/explain_userop.js";
import { mergeInterfaces } from "../scripts/lib/extensions.js";
import {
  type ManagedAccountSetup,
  buildPublishRequests,
  createManagedAccountFixtures,
} from "./fixtures/managedAccountFixture.js";

const connection = await network.create();
const { ethers, networkHelpers } = connection;
const { managedAccountFixture, sendUserOp } = createManagedAccountFixtures(connection);

function executeSelfMultiPublish(setup: ManagedAccountSetup, requests = buildPublishRequests(setup)) {
  return setup.account.interface.encodeFunctionData("execute", [
    setup.accountAddress,
    0n,
    setup.account.interface.encodeFunctionData("multiPublish", [requests]),
  ]);
}

async function explain(setup: ManagedAccountSetup, txHash: string) {
  const calls = mergeInterfaces(setup.account.interface, setup.eas.interface);
  const bundle = await explainUserOps(ethers.provider, { entryPoint: setup.entryPoint.interface, calls }, txHash);
  expect(bundle.ops).to.have.length(1);
  return bundle.ops[0];
}

describe("seed:explain-userop", function () {
  it("reports a UserOp that ran out of gas, with the gas it needed", async function () {
    const setup = await networkHelpers.loadFixture(managedAccountFixture);
    const { success, revertReason, receipt } = await sendUserOp({
      ...setup,
      signer: setup.accountAdmin,
      callData: executeSelfMultiPublish(setup),
      callGasLimit: 150_000n,
    });
    expect(success).to.equal(false);
    expect(revertReason, "out of gas leaves no logged reason").to.equal(null);

    const op = await explain(setup, receipt!.hash);
    expect(op.call).to.equal(`execute → ${setup.accountAddress}.multiPublish`);
    expect(op.outcome.kind).to.equal("out-of-gas");
    if (op.outcome.kind !== "out-of-gas") return;
    expect(op.outcome.needed > 150_000n).to.equal(true);

    // The reported amount is enough: the same call with that limit succeeds.
    const retry = await sendUserOp({
      ...setup,
      signer: setup.accountAdmin,
      callData: executeSelfMultiPublish(setup),
      callGasLimit: op.outcome.needed,
    });
    expect(retry.success, `revertReason: ${retry.revertReason}`).to.equal(true);
  });

  it("decodes a logged Seed revert", async function () {
    const setup = await networkHelpers.loadFixture(managedAccountFixture);
    const requests = buildPublishRequests(setup);
    requests[0].propertiesToUpdate = [{ publishIndex: 5n, propertySchemaUid: setup.propertySchemaUid }];
    const { success, receipt } = await sendUserOp({
      ...setup,
      signer: setup.accountAdmin,
      callData: executeSelfMultiPublish(setup, requests),
    });
    expect(success).to.equal(false);

    const op = await explain(setup, receipt!.hash);
    expect(op.outcome).to.deep.equal({ kind: "reverted", reason: 'PublishIndexOutOfBounds(uint256,uint256) ["5","1"]', replayed: false });
  });

  it("reports success", async function () {
    const setup = await networkHelpers.loadFixture(managedAccountFixture);
    const { success, receipt } = await sendUserOp({ ...setup, signer: setup.accountAdmin, callData: executeSelfMultiPublish(setup) });
    expect(success).to.equal(true);
    expect((await explain(setup, receipt!.hash)).outcome).to.deep.equal({ kind: "succeeded" });
  });

  it("refuses a transaction that isn't handleOps", async function () {
    const setup = await networkHelpers.loadFixture(managedAccountFixture);
    const tx = await setup.accountAdmin.sendTransaction({ to: setup.stranger.address, value: 1n });
    const error = await explain(setup, tx.hash).then(() => null, (e: Error) => e);
    expect(error?.message).to.include("isn't an EntryPoint v0.6 handleOps call");
  });
});
