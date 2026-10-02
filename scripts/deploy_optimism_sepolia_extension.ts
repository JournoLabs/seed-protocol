import { ethers, upgrades } from 'hardhat';



async function main() {
  // Deploy SeedProtocol
  const SeedProtocolExtension = await ethers.getContractFactory('SeedProtocolExtension');
  const seedProtocolExtension = await upgrades.deployProxy(SeedProtocolExtension, [
    '0x4200000000000000000000000000000000000021',
 ], { initializer: 'initialize' });

  if (!seedProtocolExtension) {
    throw new Error('SeedProtocolExtension not deployed');
  }

  await seedProtocolExtension.waitForDeployment();

  console.log('SeedProtocol deployed to:', seedProtocolExtension.target);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

// 4/29 Deployed to 0x9508D87306c443B6965db831417FE76ec4c4b596 on OP Sepolia
