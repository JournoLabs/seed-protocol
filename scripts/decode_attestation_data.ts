// NOTE: Hardhat 2 script, not yet ported to Hardhat 3. It will be ported or replaced
// in the deploy branch (see docs/hardhat3-migration-plan.md, H9). Expect it to fail until then.

import { ethers } from "hardhat";
import easAbi from '../eas/EAS.json'
import schemaRegistryAbi from '../eas/SchemaRegistry.json'
import {SchemaEncoder} from '@ethereum-attestation-service/eas-sdk'

const easContractAddress = ''
const data = 'Ox68ac5af3e625f5147eb627241a9eae99ead92b53a8882a27b8fd35c65f2faeb1000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000084964656e74697479000000000000000000000000000000000000000000000000'
const transactionHash = '0x7daf4e60e969d4c53a026fe1841bdd5b6b64d74832def4493cbec285d5033b0f'

const hexToString = (hex: string) => {
    let str = '';
    for (let i = 0; i < hex.length; i += 2) {
        const v = parseInt(hex.substr(i, 2), 16);
        if (!isNaN(v)) {
            str += String.fromCharCode(v);
        }
    }
    return str;
};

function hexToUtf8(s)
{
  return decodeURIComponent(
     s.replace(/\s+/g, '') // remove spaces
      .replace(/[0-9a-f]{2}/g, '%$&') // add '%' before each 2 characters
  );
}

const decoder = new TextDecoder()

async function main() {

  // const decodedData = new SchemaEncoder('bool PROXY')
  //
  // const attestationData = ethers.toUtf8String(dataInBytes)
  //
  // console.log(attestationData)

  // const contractInterface = new ethers.Interface(easAbi.abi);
  //


  const provider = new ethers.JsonRpcProvider();
  // const latestBlock = await provider.getBlockNumber();
  //
  // console.log(latestBlock)
  //
  // const events = await provider.getLogs({
  //   address: '0x4200000000000000000000000000000000000021',
  //   fromBlock: 18630406,
  //   toBlock: 18630406,
  //   topics: [
  //   '0x8bf46bf4cfd674fa735a3d63ec1c9ad4153f033c290341f3a588b75685141b35',
  //   '0x0000000000000000000000000000000000000000000000000000000000000000',
  //   '0x0000000000000000000000006002ca2e11b8e8c0f1f09c67f551b209eb51a0e4',
  //   '0x44d562ac1d7cd77e232978687fea027ace48f719cf1d58c7888e509663bb87fc'
  // ],
  //
  // })
  //
  // console.log(events)
  //
  // const network = await provider.getNetwork()
  //
  const tx = await provider.getTransaction(transactionHash);

  if (!tx) {
    console.log('No transaction found')
    return
  }

  const contractInterface = new ethers.Interface(schemaRegistryAbi.abi)

  const decodedTransaction = contractInterface.parseTransaction(tx);

  if (!decodedTransaction) {
    console.log('No transaction')
    return
  }

  // const decodedResult = contractInterface._decodeParams({name: 'name'}, data)

  console.log(decodedTransaction)

  // console.log(decodedData?.fragment.inputs[0].components)
  // console.log(decodedData?.args)

  const receipt = await tx.wait()

  if (!receipt) {
    console.log('No receipt')
    return
  }

  console.log(receipt.logs.length)

  for ( let i = 0; i < receipt.logs.length; i++ ) {
    const log = receipt.logs[i]
    console.log(log.toJSON())
    // const dataInBytes = ethers.getBytes(data)
    // const testing = decoder.decode(dataInBytes)
    // console.log(testing)
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
