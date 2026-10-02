/**
 * The SeedProtocol Ignition module deployed with `--strategy create2` through
 * CreateX, and the sender-guarded salt it relies on. See docs/deploy-plan.md (P2, step 1).
 */
import { expect } from "chai";
import { Contract, dataSlice } from "ethers";
import hre, { network } from "hardhat";
import SeedProtocolModule from "../ignition/modules/SeedProtocol.js";
import { createxAddress, createxSalt } from "../scripts/lib/createxSalt.js";
import { predictAddresses } from "../scripts/predict_addresses.js";

const OP_EAS = "0x4200000000000000000000000000000000000021";
const SEED_DEPLOYER = "0x00467fe2608Dff148C83009927E4e7234Bc4D84B";

const CONTRACTS = [
  { key: "seedProtocolExtension", name: "SeedProtocolExtension", args: (eas: string) => [eas] },
  { key: "seedProtocolExtensionV2", name: "SeedProtocolExtensionV2", args: (eas: string) => [eas] },
  { key: "seedProtocolExecutor", name: "SeedProtocolExecutor", args: () => [] },
] as const;

describe("SeedProtocol Ignition module (create2)", function () {
  it("configures a salt guarded for the Seed deployer, without cross-chain redeploy protection", function () {
    const salt = hre.config.ignition.strategyConfig?.create2?.salt;
    expect(salt).to.equal(createxSalt(SEED_DEPLOYER, "seed-v1"));
    expect(dataSlice(salt!, 0, 20)).to.equal(SEED_DEPLOYER.toLowerCase());
    expect(dataSlice(salt!, 20, 21)).to.equal("0x00");
  });

  it("deploys every contract to the address CreateX's guarded salt predicts, and only that sender gets them", async function () {
    const connection = await network.create();
    const { ethers, networkHelpers } = connection;
    const [owner, other] = await ethers.getSigners();
    const eas = OP_EAS;
    // The constructors only check that EAS has code; nothing here calls it.
    await networkHelpers.setCode(eas, "0x00");
    const salt = createxSalt(owner.address, "seed-test");

    async function deployFrom(sender: string) {
      return connection.ignition.deploy(SeedProtocolModule, {
        parameters: { SeedProtocol: { eas } },
        strategy: "create2",
        strategyConfig: { salt },
        defaultSender: sender,
      });
    }

    async function predict(name: string, args: unknown[], sender: string) {
      const factory = await ethers.getContractFactory(name);
      const initCode = (await factory.getDeployTransaction(...args)).data;
      return createxAddress(salt, sender, initCode);
    }

    // The other sender goes first: it also makes Ignition bootstrap CreateX on this chain.
    const otherDeployment = await deployFrom(other.address);
    const predicted = await predictAddresses(connection, hre, { eas, deployer: owner.address, salt });
    expect(predicted.map((p) => p.status)).to.deep.equal(["free", "free", "free", "free"]);
    const ownerDeployment = await deployFrom(owner.address);

    for (const { key, name, args } of CONTRACTS) {
      const ownerAddress = await ownerDeployment[key].getAddress();
      const otherAddress = await otherDeployment[key].getAddress();
      expect(ownerAddress, `${name} (owner)`).to.equal(await predict(name, args(eas), owner.address));
      expect(otherAddress, `${name} (other sender)`).to.equal(await predict(name, args(eas), other.address));
      expect(otherAddress, name).to.not.equal(ownerAddress);
    }

    // seed:predict-addresses saw the same addresses, router extension included.
    for (const p of predicted) expect(await ownerDeployment[p.contract].getAddress(), p.contract).to.equal(p.address);
    const after = await predictAddresses(connection, hre, { eas, deployer: owner.address, salt });
    expect(after.map((p) => p.status)).to.deep.equal(["deployed", "deployed", "deployed", "deployed"]);

    // The router extension's address depends on the executor's, so check its wiring rather than predict it.
    const executor = await ownerDeployment.seedProtocolExecutor.getAddress();
    const router = new Contract(
      await ownerDeployment.seedExecutorRouterExtension.getAddress(),
      (await ethers.getContractFactory("SeedExecutorRouterExtension")).interface,
      ethers.provider,
    );
    expect(await router.getSeedExecutor()).to.deep.equal([executor, eas]);
    expect(await ownerDeployment.seedProtocolExtension.getEas()).to.equal(eas);
  });
});
