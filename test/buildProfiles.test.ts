/**
 * `ignition deploy` builds the `production` profile on live networks, while the tests,
 * rehearsals and seed:predict-addresses use `default`. Any difference between them moves
 * the CREATE2 addresses and deploys bytecode the tests never ran (docs/deploy-plan.md, P3).
 */
import { expect } from "chai";
import hre from "hardhat";

describe("solidity build profiles", function () {
  it("production compiles exactly like default (paris, isolated)", function () {
    const { default: def, production } = hre.config.solidity.profiles;
    expect([def.isolated, production.isolated]).to.deep.equal([true, true]);
    expect(production.compilers.map((c) => [c.version, c.settings])).to.deep.equal(
      def.compilers.map((c) => [c.version, c.settings]),
    );
    expect(production.compilers.map((c) => c.settings.evmVersion)).to.deep.equal(["paris"]);
  });
});
