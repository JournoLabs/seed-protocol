import { readFile } from "node:fs/promises";
import path from "node:path";
import { Contract, ContractFactory, getAddress } from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import { CREATE_X, SEED_DEPLOYER, createxAddress } from "./lib/createxSalt.js";
import type { SeedAddresses } from "./lib/seedDeployment.js";

/**
 * `hardhat seed:predict-addresses`: where `ignition deploy --strategy create2` will put
 * the SeedProtocol contracts when run by the Seed deployer, and whether it would
 * succeed there (docs/deploy-plan.md, P2 and step 9.1).
 *
 * Read-only: each address is computed offline, then `deployCreate2` is `eth_call`ed
 * from the deployer to confirm CreateX would create exactly that contract. Safe on
 * any network.
 */

const CREATE_X_ABI = ["function deployCreate2(bytes32 salt, bytes initCode) payable returns (address)"];

interface Args {
  parameters: string;
  deployer: string;
}

type Connection = Awaited<ReturnType<HardhatRuntimeEnvironment["network"]["getOrCreate"]>>;

export interface Prediction {
  contract: keyof SeedAddresses;
  address: string;
  /** "free" (deployCreate2 would create it), "deployed", or why the call failed. */
  status: string;
}

export default async function predictAddressesTask(args: Args, hre: HardhatRuntimeEnvironment) {
  const connection = await hre.network.getOrCreate();
  const parametersFile = args.parameters || `ignition/parameters/${connection.networkName}.json`;
  const parameters = JSON.parse(await readFile(path.resolve(hre.config.paths.root, parametersFile), "utf8"));
  const salt = hre.config.ignition.strategyConfig?.create2?.salt;
  if (!salt) throw new Error("No ignition.strategyConfig.create2.salt in hardhat.config.ts");

  const deployer = getAddress(args.deployer || SEED_DEPLOYER);
  const predictions = await predictAddresses(connection, hre, { eas: parameters.SeedProtocol.eas, deployer, salt });

  console.log(`Network ${connection.networkName}, deployer ${deployer}, salt ${salt}`);
  for (const p of predictions) console.log(`  ${p.contract.padEnd(28)} ${p.address}  ${p.status}`);
  if (predictions.some((p) => p.status !== "free" && p.status !== "deployed")) process.exitCode = 1;
}

export async function predictAddresses(
  { ethers }: Pick<Connection, "ethers">,
  hre: HardhatRuntimeEnvironment,
  { eas, deployer, salt }: { eas: string; deployer: string; salt: string },
): Promise<Prediction[]> {
  if ((await ethers.provider.getCode(CREATE_X)) === "0x") throw new Error(`CreateX isn't deployed at ${CREATE_X} here`);
  const createX = new Contract(CREATE_X, CREATE_X_ABI, ethers.provider);

  /**
   * `stateOverride` gives not-yet-deployed dependencies their code, so a contract whose
   * constructor checks them (the router extension checks the executor) can be dry-run too.
   */
  async function predict(
    contract: keyof SeedAddresses,
    name: string,
    args: unknown[],
    stateOverride: Record<string, { code: string }> = {},
  ): Promise<Prediction & { runtimeCode?: string }> {
    const artifact = await hre.artifacts.readArtifact(name);
    const initCode = (await new ContractFactory(artifact.abi, artifact.bytecode).getDeployTransaction(...args)).data;
    const address = createxAddress(salt, deployer, initCode);
    if ((await ethers.provider.getCode(address)) !== "0x") return { contract, address, status: "deployed" };
    const call = { from: deployer, to: CREATE_X, data: createX.interface.encodeFunctionData("deployCreate2", [salt, initCode]) };
    try {
      const result = await ethers.provider.send("eth_call", [call, "latest", stateOverride]);
      const [created] = createX.interface.decodeFunctionResult("deployCreate2", result);
      if (getAddress(created) !== address) return { contract, address, status: `CreateX would use ${created}` };
      return { contract, address, status: "free", runtimeCode: artifact.deployedBytecode };
    } catch (e) {
      return { contract, address, status: `deployCreate2 would revert: ${(e as Error).message.split("\n")[0]}` };
    }
  }

  const { runtimeCode, ...executor } = await predict("seedProtocolExecutor", "SeedProtocolExecutor", []);
  // SeedProtocolExecutor has no immutables, so its artifact's runtime code is what gets deployed.
  const executorCode = runtimeCode ? { [executor.address]: { code: runtimeCode } } : {};
  const strip = ({ runtimeCode: _, ...p }: Prediction & { runtimeCode?: string }): Prediction => p;
  return [
    strip(await predict("seedProtocolExtension", "SeedProtocolExtension", [eas])),
    strip(await predict("seedProtocolExtensionV2", "SeedProtocolExtensionV2", [eas])),
    executor,
    strip(await predict("seedExecutorRouterExtension", "SeedExecutorRouterExtension", [eas, executor.address], executorCode)),
  ];
}
