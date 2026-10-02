import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";

type Connection = Awaited<ReturnType<HardhatRuntimeEnvironment["network"]["getOrCreate"]>>;

/**
 * True for the in-process network and for a `hardhat node` (local or forking),
 * where impersonation works and writes don't touch a real chain.
 */
export async function isSimulated({ ethers, networkConfig }: Connection): Promise<boolean> {
  if (networkConfig.type === "edr-simulated") return true;
  try {
    const client: string = await ethers.provider.send("web3_clientVersion", []);
    return /hardhat|edr/i.test(client);
  } catch {
    return false;
  }
}
