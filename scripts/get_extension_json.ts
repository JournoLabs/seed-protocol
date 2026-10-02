// NOTE: Hardhat 2 script, not yet ported to Hardhat 3. It will be ported or replaced
// in the deploy branch (see docs/hardhat3-migration-plan.md, H9). Expect it to fail until then.

import { Contract, keccak256, toUtf8Bytes } from 'ethers'
import { ethers }                           from 'hardhat'
import SeedProtocolExtensionJson
                                            from '../artifacts/contracts/SeedProtocolExtension.sol/SeedProtocolExtension.json'

/*
*  { "metadata": { "name": "...", "metadataURI": "...", "implementation": "0x..." }, "functions": [{ "functionSelector": "0", "functionSignature": "..." }] }
* */

const deployments = [
  {
    name: "SeedProtocolExtension",
    metadataURI: "ipfs://QmfNsWGDnnKVw5bYuWnvy9j13bhv4vH3XeaJH6SuDLPjyw",
    implementation: "0x9508D87306c443B6965db831417FE76ec4c4b596",
  },
   {
    name: "SeedProtocol",
    metadataURI: "ipfs://QmYE8PKKUTm6LCGqmcm8szG28pj8KMdYbeWVHDREkg9cMg",
    implementation: "0xA2b8315fd0F31c334be1B137D9E0FfbB3F200E57",
  },
  {
    name: "SeedProtocolExtension",
    metadataURI: "ipfs://QmfNsWGDnnKVw5bYuWnvy9j13bhv4vH3XeaJH6SuDLPjyw",
    implementation: "0xf331b31A8e613320AA4b78ee908ee639E5936da8",
  },
  {
    name: "SeedProtocolExtension",
    metadataURI: "ipfs://QmfNsWGDnnKVw5bYuWnvy9j13bhv4vH3XeaJH6SuDLPjyw",
    implementation: "0xe8A567d96BaaF98805A186bb825cC0b2430b607A",
  }
]

const functionsToAdd = [
  'multiPublish',
  'setEas',
  'getEas'
]

export const generateExpandedSignature = (methodName: string, fragment,) => {
  const expandType = (type,) => {
    if (type.baseType === 'tuple') {
      const components = type.components.map((component,) => {
        return `${expandType(component,)}`
      },).join(',',)
      return `(${components})${type.arrayChildren ? '[]' : ''}`
    } if(type.baseType === 'array') {
      return `${expandType(type.arrayChildren,)}[]`

    } else {
      return `${type.type}${type.arrayChildren ? '[]' : ''}`
    }
  }

  const inputs = fragment.inputs.map((input,) => {
    return expandType(input,)
  },).join(',',)

  return `${fragment.name}(${inputs})`
}


async function main() {


  const [ signer ] = await ethers.getSigners();

  const ethersContract = new Contract('0x9508D87306c443B6965db831417FE76ec4c4b596', SeedProtocolExtensionJson.abi, signer,)





  for (const deployment of deployments) {

    const functions = []

    for (const functionName of functionsToAdd) {
      const methodFragment = ethersContract.getFunction(functionName,)

      // console.log('Method fragment', methodFragment.fragment,)

      const signature = generateExpandedSignature(functionName, methodFragment.fragment,)

      // console.log('Signature', signature,)

      const selector = keccak256(toUtf8Bytes(signature)).slice(0, 10)
      // console.log(selector)

      functions.push({
        functionSelector: selector,
        functionSignature: signature
      })

    }


    const extensionData = {
      metadata: {
        name: deployment.name,
        metadataURI: deployment.metadataURI,
        implementation: deployment.implementation,
      },
      functions,
    }

    console.log(JSON.stringify(extensionData, null, 2))
  }

  // const extensionData = {
  //   metadata: {
  //     name: "SeedProtocolExtension",
  //     metadataURI: "ipfs://QmVkh8EK8Z8m7sDFW2Fq7AgsP34f4YSsZrx8KLDUjfcgFF",
  //     implementation: "0xC522f9399c4456593147eC4D2B3425415d48b893",
  //   },
  //   functions: [
  //     {
  //       functionSelector: keccak256(toUtf8Bytes('multiPublish(PublishRequestData[])')).slice(0, 10),
  //       functionSignature: 'multiPublish(PublishRequestData[])'
  //     }
  //   ]
  // }
  //
  // console.log(JSON.stringify(extensionData, null, 2))
  //
  // return extensionData
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

//
