// NOTE: Hardhat 2 script, not yet ported to Hardhat 3. It will be ported or replaced
// in the deploy branch (see docs/hardhat3-migration-plan.md, H9). Expect it to fail until then.

import { ethers, upgrades } from 'hardhat';
import { Contract }         from 'ethers'
import SeedProtocolJson                                     from '../artifacts/contracts/SeedProtocol.sol/SeedProtocol.json'
import { singlePublishRequestData, testPublishRequestData } from './utils/test_data'


const versionSchemaUid = '0x13c0fd59d69dbce40501a41f8b37768d26dd2e2bb0cad64615334d84f7b9bdf6'
const postSchemaUid = '0x8fad85bc255f47ba00cdf83e0bb4b606ca1e703974ba0d8295241cbba04ce7d7'


const testPostUid = '0x2a34bcc7d384ee1a0999affae1b4712cb538ee0a1e237de3b748d3dba2395a53'

const testMethod = async (seedProtocolContract, methodName, args: any[]) => {
    const functionFragment = seedProtocolContract.getFunction(methodName);

  if (!functionFragment) {
    throw new Error('createSeed function fragment not found');
  }

  console.log(`has ${methodName}!`)

  const result = await seedProtocolContract[methodName](...args, {
    gasLimit: 3000000n,
  })

  const receipt = await result.wait()

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
}

async function main() {
  const [signer] = await ethers.getSigners();

  console.log(signer.address);

  const seedProtocolContract = new Contract('0xA2b8315fd0F31c334be1B137D9E0FfbB3F200E57', SeedProtocolJson.abi, signer);



  // await testMethod(seedProtocolContract, 'createSeed', [postSchemaUid, true])

  // await testMethod(seedProtocolContract, 'createVersion', [testPostUid, versionSchemaUid])

  // await testMethod(seedProtocolContract, 'publish', [singlePublishRequestData])


  await testMethod(seedProtocolContract, 'multiPublish', [testPublishRequestData])


}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
