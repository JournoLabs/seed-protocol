// NOTE: Hardhat 2 script, not yet ported to Hardhat 3. It will be ported or replaced
// in the deploy branch (see docs/hardhat3-migration-plan.md, H9). Expect it to fail until then.

import { ethers } from 'hardhat'

const main = async () => {

  const [owner] = await ethers.getSigners()

  const tx = await owner.sendTransaction({
    to: process.env.TEST_ADDRESS,
    value: ethers.parseEther('40')
  });

  console.log(`Transaction sent: ${tx.hash}`);

  // Wait for the transaction to be mined and confirmed
  // const receipt = await ethers.provider.waitForTransaction(tx.hash);

  const receipt = await tx.wait()

  console.log(receipt)

  // console.log(`Transaction confirmed in block ${receipt.blockNumber}`);

};

const runMain = async () => {
  try {
    await main();
    process.exit(0);
  } catch (error) {
    console.log(error);
    process.exit(1);
  }
};

runMain();

