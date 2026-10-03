import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import { buildSeedExtensions, defaultDeploymentId, loadSeedAddresses } from "./lib/seedDeployment.js";

/**
 * `hardhat seed:extension-payload`: prints the `Extension` structs for the factory's
 * Router, built from an Ignition deployment, as JSON for review or a dashboard.
 * Replaces get_extension_json.ts (docs/deploy-plan.md, step 3).
 */
export default async function buildExtensionPayload(
  { deploymentId, metadataUri }: { deploymentId: string; metadataUri: string },
  hre: HardhatRuntimeEnvironment,
) {
  const { ethers } = await hre.network.getOrCreate();
  const { chainId } = await ethers.provider.getNetwork();
  const id = deploymentId || defaultDeploymentId(chainId);

  const extensions = await buildSeedExtensions(hre, await loadSeedAddresses(hre, id), metadataUri);
  console.log(
    JSON.stringify(
      {
        deploymentId: id,
        chainId: chainId.toString(),
        // Registered now (P7).
        replaceExtension: extensions.seedProtocolExtension,
        addExtension: extensions.seedExecutorRouterExtension,
      },
      null,
      2,
    ),
  );
}
