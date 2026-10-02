// NOTE: Hardhat 2 script, not yet ported to Hardhat 3. It will be ported or replaced
// in the deploy branch (see docs/hardhat3-migration-plan.md, H9). Expect it to fail until then.

import { ethers }                       from "hardhat";
import { SchemaRegistry, ZERO_ADDRESS } from '@ethereum-attestation-service/eas-sdk'
import schemaRegistryAbi                from '../eas/SchemaRegistry.json'

const schemaRegistryContractAddress = "0xa7b39296258348c78294f95b872b282326a97bdf";
const schemaRegistry = new SchemaRegistry(schemaRegistryContractAddress);

const transactionHash = '0xc564ecbb7a76f2e1350f2090cac6bdddb6bb8df48e24cd8903c6dca11c5c2f08';
const uid = '0x820a7230bbd6e1fed20336deba7da5d1adeb33bd84cd0ae7f6f89b61c1b637b2'

const permaPressContractAddress = '0xc3e53F4d16Ae77Db1c982e75a937B9f60FE63690'
const linkSchemaDefinition = 'string uri'
const displayNameSchemaDefinition = 'string display_name'
const contentHashSchemaDefinition = 'string content_hash'
const avatarImageUriSchemaDefinition = 'string avatar_image_uri'
const avatarImageDataSchemaDefinition = 'string avatar_image_data'
const coverImageUriSchemaDefinition = 'string cover_image_uri'
const coverImageDataSchemaDefinition = 'string cover_image_data'
const profileSchemaDefinition = 'string profile'


const identityStringFields = [
  'display_name',
  'cover_image_uri',
  'avatar_image_uri',
  'profile',
  'content_hash',
  'avatar_image_data',
  'cover_image_data',
]

async function main() {
  const [ signer ] = await ethers.getSigners();

  const provider = new ethers.JsonRpcProvider();

  schemaRegistry.connect(signer)

  const schemaDefinition = `string uri`

  const transaction = await schemaRegistry.register({
    schema: schemaDefinition,
    resolverAddress: ZERO_ADDRESS,
    revocable: true,
  });

  const uid = await transaction.wait()

  console.log(`link: ${uid}`)

  // for ( let i = 0; i < identityStringFields.length; i++ ) {
  //   const stringField = identityStringFields[i]
  //   const schemaDefinition = `string ${stringField}`
  //
  //   const transaction = await schemaRegistry.register({
  //     schema: schemaDefinition,
  //     resolverAddress: ZERO_ADDRESS,
  //     revocable: true,
  //   });
  //
  //   const uid = await transaction.wait()
  //
  //   console.log(`${stringField}: ${uid}`)
  //
  //
  // }

  // Bundle a real test of saving Itdentity


}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
