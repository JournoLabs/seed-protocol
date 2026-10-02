import { ethers, upgrades } from 'hardhat';



async function main() {
  // Deploy SeedProtocol
  const SeedProtocolExtension = await ethers.getContractFactory('SeedProtocolExtension');
  const seedProtocolExtension = await upgrades.upgradeProxy('0xf331b31A8e613320AA4b78ee908ee639E5936da8', SeedProtocolExtension);

  if (!seedProtocolExtension) {
    throw new Error('SeedProtocolExtension not deployed');
  }

  await seedProtocolExtension.waitForDeployment();

  console.log('SeedProtocolExtension deployed to:', seedProtocolExtension.target);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
