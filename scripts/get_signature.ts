// NOTE: Hardhat 2 script, not yet ported to Hardhat 3. It will be ported or replaced
// in the deploy branch (see docs/hardhat3-migration-plan.md, H9). Expect it to fail until then.

import { ethers, }                          from 'hardhat'
import { Contract, keccak256, toUtf8Bytes } from 'ethers'
import SeedProtocolExtensionJson            from '../artifacts/contracts/SeedProtocolExtension.sol/SeedProtocolExtension.json'

export const generateExpandedSignature = (methodName, fragment,) => {
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

  const methodFragment = ethersContract.getFunction('multiPublish',)

  console.log('Method fragment', methodFragment.fragment,)

  const signature = generateExpandedSignature('multiPublish', methodFragment.fragment,)

  console.log('Signature', signature,)

   const selector = keccak256(toUtf8Bytes(signature)).slice(0, 10)
  console.log(selector)

}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
