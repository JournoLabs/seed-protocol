/**
 * The SeedProtocol Ignition module deployed with `--strategy create2` through
 * CreateX, and the sender-guarded salt it relies on. See docs/deploy-plan.md (P2, step 1).
 */
import { expect } from "chai";
import { AbiCoder, Contract, concat, dataSlice, getCreate2Address, keccak256 } from "ethers";
import hre, { network } from "hardhat";
import SeedProtocolModule from "../ignition/modules/SeedProtocol.js";
import { createxSalt } from "../scripts/lib/createxSalt.js";

const CREATE_X = "0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed";
const OP_EAS = "0x4200000000000000000000000000000000000021";
const SEED_DEPLOYER = "0x00467fe2608Dff148C83009927E4e7234Bc4D84B";

const CONTRACTS = [
  { key: "seedProtocolExtension", name: "SeedProtocolExtension", args: (eas: string) => [eas] },
  { key: "seedProtocolExtensionV2", name: "SeedProtocolExtensionV2", args: (eas: string) => [eas] },
  { key: "seedProtocolExecutor", name: "SeedProtocolExecutor", args: () => [] },
] as const;

/** The salt CreateX's `_guard` actually passes to CREATE2 for `sender`. */
function guardedSalt(salt: string, sender: string): string {
  const saltSender = dataSlice(salt, 0, 20).toLowerCase();
  const flag = dataSlice(salt, 20, 21);
  if (saltSender === sender.toLowerCase() && flag === "0x00") {
    return keccak256(concat([AbiCoder.defaultAbiCoder().encode(["address"], [sender]), salt]));
  }
  // The "random" branch: anyone else using this salt.
  return keccak256(AbiCoder.defaultAbiCoder().encode(["bytes32"], [salt]));
}

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
      return getCreate2Address(CREATE_X, guardedSalt(salt, sender), keccak256(initCode));
    }

    const ownerDeployment = await deployFrom(owner.address);
    const otherDeployment = await deployFrom(other.address);

    for (const { key, name, args } of CONTRACTS) {
      const ownerAddress = await ownerDeployment[key].getAddress();
      const otherAddress = await otherDeployment[key].getAddress();
      expect(ownerAddress, `${name} (owner)`).to.equal(await predict(name, args(eas), owner.address));
      expect(otherAddress, `${name} (other sender)`).to.equal(await predict(name, args(eas), other.address));
      expect(otherAddress, name).to.not.equal(ownerAddress);
    }

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
