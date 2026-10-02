import {expect}                                                   from 'chai'
import { deployToLocalHardhat, ValuesStore }                      from '../scripts/utils/deploy'
import { testPublishRequestData }                                 from '../scripts/utils/test_data'
import {isHexString}                                              from 'ethers'

const callFunction = async (contract: any, functionName: string, args: any[]) => {
  const functionFragment = contract.getFunction(functionName);

  if (!functionFragment) {
    throw new Error(`${functionName} function fragment not found`);
  }

  const result = await contract[functionName](...args, {
    gasLimit: 3000000n,
  })

  if (!result || !result.wait) {
    console.log('result', result)
    return result
  }

  const receipt = await result.wait()

  const logs = []

  for (const log of receipt.logs) {
    if (log.args) {
      console.log(contract.interface.parseLog(log))
      logs.push(contract.interface.parseLog(log))
    }
  }

  return logs
}


describe('SeedProtocol', () => {
  let valuesStore: ValuesStore = {}

  before(async () => {

    valuesStore = await deployToLocalHardhat()


  });

  it('should work', async function () {
    expect(isHexString(
      valuesStore.identitySeedUid
    )).to.be.true;
  });

  it('should create an Identity seed using the Identity Schema UID, and return the UID of the new seed', async function () {
    expect(isHexString(
      valuesStore.identitySeedUid
    )).to.be.true;
  });

  it('should create a post seed and return the UID', async function () {
    expect(isHexString(
      valuesStore.postSeedUid
    )).to.be.true;
  });

  it('should get and set the EAS address properly', async function () {
    const setLogs = await callFunction(valuesStore.seedProtocol, 'setEas', [valuesStore.easAddress])
    console.log('setLogs:', setLogs)
    const easAddress = await callFunction(valuesStore.seedProtocol, 'getEas', [])
    if (easAddress && typeof easAddress === 'string') {
      expect(easAddress).to.equal(valuesStore.easAddress)
    }
  });

  // it('should deploy all schemas for Identity properties', async function () {
  //   expect(isHexString(
  //     valuesStore.displayNameSchemaUid
  //   )).to.be.true;
  //   expect(isHexString(
  //     valuesStore.profileSchemaUid
  //   )).to.be.true;
  //   expect(isHexString(
  //     valuesStore.uriSchemaUid
  //   )).to.be.true;
  //   expect(isHexString(
  //     valuesStore.labelSchemaUid
  //   )).to.be.true;
  //   expect(isHexString(
  //     valuesStore.linkSchemaUid
  //   )).to.be.true;
  // });

  it('should create a version for the identity seed and return the UID of the new version', async function () {

    const {
      seedProtocol,
      eas,
      versionSchemaUid,
      identitySeedUid,
      modelUids,
    } = valuesStore

    if (!eas) {
      throw new Error('EAS contract not found');
    }

    if (!seedProtocol) {
      throw new Error('SeedProtocol contract not found');
    }

    if (!modelUids) {
      throw new Error('PropertyData not found');
    }

    const createVersion = seedProtocol.getFunction('createVersion');

    if (!createVersion) {
      throw new Error('Function fragment not found');
    }

    console.log('calling createVersion with identitySeedUid', identitySeedUid, 'versionSchemaUid', versionSchemaUid)

    const logs = await callFunction(seedProtocol, 'createVersion', [identitySeedUid, versionSchemaUid])

    const returnedUids: string[] = []

    for (const log of logs) {
      if (log.args) {
        const arg = log.args[0]
        if (arg && arg.length === 64) {
          returnedUids.push(`0x${arg}`)
        }
      }
    }

    console.log(returnedUids)

    // const transaction = await createVersion.send(identitySeedUid, versionSchemaUid, {
    //   value: BigInt(0),
    //   // gasLimit: BigInt(1022881482n),
    //   gasLimit: 30000000n,
    // });
    //
    // console.log('transaction', transaction)
    //
    // const receipt = await transaction.wait();
    //
    // console.log('receipt', receipt)
  //
  //   if (!receipt) {
  //     throw new Error('Transaction failed');
  //   }
  //
  //   if (!receipt.logs || receipt.logs.length === 0) {
  //     throw new Error('No logs found');
  //   }
  //

  //
  //   console.log(returnedUids)
  //
  //   for ( let j = 0; j < returnedUids.length; j++ ) {
  //     const uid = returnedUids[j]
  //     expect(isHexString(uid)).to.be.true;
  //
  //     const attestation = await eas.getAttestation(uid)
  //     expect(attestation).to.not.be.null
  //   }
  //
  //
  });

  // it('should use multiPublish to publish all attestations needed for a seed', async function () {
  //   const {
  //     seedProtocol,
  //     eas,
  //   } = valuesStore
  //
  //   if (!seedProtocol) {
  //     throw new Error('SeedProtocol contract not found');
  //   }
  //
  //   const multiPublish = seedProtocol.getFunction('multiPublish');
  //
  //   if (!multiPublish) {
  //     throw new Error('multiPublish function fragment not found');
  //   }
  //
  //   const transaction = await multiPublish.send(testPublishRequestData, {
  //     value: BigInt(0),
  //     // gasLimit: BigInt(1022881482n),
  //     gasLimit: 30000000n,
  //   });
  //
  //   const result = await seedProtocol.multiPublish(testPublishRequestData)
  //
  //   const done = await result.wait()
  //
  //   // console.log('===== done =====')
  //   // console.log(done)
  //   // console.log('===== /done =====')
  //
  //   const receipt = await transaction.wait();
  //
  //   // seedProtocol.interface.forEachEvent((event, index) => {
  //   //   // console.log(event)
  //   //   console.log(`index: ${index}`)
  //   //   console.log(seedProtocol.interface.decodeEventLog(event, logs[0].data, logs[0].topics))
  //   // })
  //
  //   // Log the messages
  //   // logs.forEach(log => {
  //   //     console.log(log.toJSON());
  //   //     console.log(seedProtocol.interface.decodeEventLog('Log', log.data, log.topics))
  //   // });
  //
  //
  //   if (!receipt) {
  //     throw new Error('Transaction failed');
  //   }
  //
  //   if (!receipt.logs || receipt.logs.length === 0) {
  //     throw new Error('No logs found');
  //   }
  //
  //   const returnedUids: string[] = []
  //
  //   for ( let i = 0; i < receipt.logs.length; i++ ) {
  //     const log = receipt.logs[i]
  //     if (log.args) {
  //       const arg = log.args[0]
  //       console.log(arg)
  //       if (arg && arg.length === 64) {
  //         returnedUids.push(`0x${arg}`)
  //       }
  //     }
  //   }
  //
  //   console.log(returnedUids)
  //
  //   for ( let j = 0; j < returnedUids.length; j++ ) {
  //     const uid = returnedUids[j]
  //     expect(isHexString(uid)).to.be.true;
  //
  //     const attestation = await eas!.getAttestation(uid)
  //     expect(attestation).to.not.be.null
  //   }
  //
  //   // console.log(receipt.toJSON())
  // })
})

