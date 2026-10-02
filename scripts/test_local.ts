// NOTE: Hardhat 2 script, not yet ported to Hardhat 3. It will be ported or replaced
// in the deploy branch (see docs/hardhat3-migration-plan.md, H9). Expect it to fail until then.

import { ethers, upgrades } from 'hardhat';
import { Contract }         from 'ethers'
import SeedProtocolJson     from '../artifacts/contracts/SeedProtocol.sol/SeedProtocol.json'
import { testPublishRequestData } from './utils/test_data'



async function main() {
  const [signer] = await ethers.getSigners();

  console.log(signer.address);

  const seedProtocolContract = new Contract('0x99bba657f2bbc93c02d617f8ba121cb8fc104acf', SeedProtocolJson.abi, signer);

  const multiPublish = seedProtocolContract.getFunction('multiPublish');

  if (!multiPublish) {
    throw new Error('multiPublish function fragment not found');
  }

  console.log('has multiPublish!')

  // const estimatedGas = await multiPublish.estimateGas(testPublishRequestData)
  // console.log('estimatedGas', estimatedGas.toString())

    try {
    // const transaction = await multiPublish.send(testPublishRequestData, {
    //   value: BigInt(0),
    //   // gasLimit: BigInt(1022881482n),
    //   gasLimit: 300000n,
    // });
    //
    // const receipt = await transaction.wait();
    //
    // if (!receipt) {
    //   console.error('Transaction failed');
    //   return
    // }

    const result = await seedProtocolContract.multiPublish(testPublishRequestData, {
      gasLimit: 300000n,
    })

    const receipt = await result.wait()

    // console.log('===== done =====')
    // console.log(receipt)
    // console.log('===== /done =====')

    console.log('receipt.logs.length', receipt.logs.length)

    for (const log of receipt.logs) {
      // console.log('log.index', log.index)
      // console.log('log.topics', log.topics)
      if (log.args) {
        // console.log(log.toJSON())
        // const finalResult = JSON.parse(log.args[0])
        // console.log(JSON.stringify(log.args))
        // console.log(finalResult)
        console.log(seedProtocolContract.interface.parseLog(log))
      }
    }

  } catch (error) {
    console.error(error)

  }

}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
