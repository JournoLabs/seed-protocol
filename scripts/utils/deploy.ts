import { ethers, upgrades }                      from 'hardhat'
import { EAS__factory, SchemaRegistry__factory } from '../../typechain-types'
import {
  EAS,
  SchemaEncoder,
  SchemaItem,
  SchemaRegistry,
  ZERO_ADDRESS,
  ZERO_BYTES32
} from '@ethereum-attestation-service/eas-sdk'
import { Contract }                                                     from 'ethers'
import {
  IdentitySchemaUids,
  ModelInfo,
  ModelProperty,
  ModelUids,
  NameSchema,
  ProcessModelSchema,
  PropertyInfo
} from '../types'
import {
  postSchemaDefEncoded,
  postSchemaDefinition,
  createSeed,
  displayNameSchemaDefEncoded,
  getUid,
  identitySchemaDefEncoded,
  identitySchemaDefinition,
  labelSchemaDefEncoded,
  linkSchemaDefEncoded,
  modelSchema,
  nameASchemaDefEncoded,
  nameASchemaDefinition,
  profileSchemaDefEncoded,
  SchemaTypes,
  uriSchemaDefEncoded,
  versionSchemaDefEncoded,
  versionSchemaDefinition,
  titleSchemaDefEncoded,
  summarySchemaDefEncoded,
  byte32Props,
  stringProps
} from './index'


const assembleSchemaString = (info: PropertyInfo): string => {
    return `${info.type} ${info.name}`
}

const nameSchema: NameSchema = async ({
    eas,
    schemaUid,
    schemaName,
    nameASchemaUid
}) => {

  const nameASchemaEncoder = new SchemaEncoder(nameASchemaDefinition)

  const formattedSchemaName = schemaName
    // To snake_case
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase();

  const nameSchemaData: SchemaItem[] = [
    {name: 'schemaId', value: schemaUid, type: 'bytes32'},
    {name: 'name', value: formattedSchemaName, type: 'string'}
  ]

  const tx = await eas.attest({
    schema: nameASchemaUid,
    data: {
      recipient: ZERO_ADDRESS,
      data: nameASchemaEncoder.encodeData(nameSchemaData),
      revocable: true,
      refUID: ZERO_BYTES32,
      expirationTime: BigInt(0)
    }
  })

  await tx.wait()
}

const processModelSchema: ProcessModelSchema = async ({
    modelSchema,
    schemaRegistry,
    nameASchemaUid,
    eas,
}): Promise<ModelUids> => {

  const modelUids: ModelUids = {};

  for (const modelName in modelSchema) {
    console.log(modelName)
    const model = modelSchema[modelName];
    modelUids[modelName] = {
      properties: {},
    } as ModelInfo;

    modelUids[modelName].schemaDefinition = assembleSchemaString(model.info);
    modelUids[modelName].schemaUid = await getUid(schemaRegistry, modelUids[modelName].schemaDefinition);
    await nameSchema({
      eas,
      schemaUid: modelUids[modelName].schemaUid,
      schemaName: modelName,
      nameASchemaUid,
    })

    for (const propName in model.properties) {
      const schemaDefinition = assembleSchemaString(model.properties[propName]);
      const schemaUid = await getUid(schemaRegistry, schemaDefinition);
      await nameSchema({
        eas,
        schemaUid,
        schemaName: propName,
        nameASchemaUid,
      })
      const propertyInfo = model.properties[propName]
      const propertyData: ModelProperty = {
          schemaUid,
          schemaDefinition,
          dataType: propertyInfo.type,
      }
      if (propertyInfo.ref) {
        propertyData.ref = propertyInfo.ref
      }
      if (propertyInfo.list) {
        propertyData.list = propertyInfo.list
      }

      modelUids[modelName].properties[propName] = propertyData;

    }
  }

  return modelUids;
}

export type PropertyData = {
  schemaUid: string
  schemaDefinition: string
  dataType: string
}

export type ValuesStore = {
  seedProtocol?: Contract
  schemaRegistry?: SchemaRegistry
  schemaRegistryAddress?: string
  easAddress?: string
  eas?: EAS
  identitySchemaUid?: string
  postSchemaUid?: string
  versionSchemaUid?: string
  nameASchemaUid?: string
  postSeedUid?: string
  identitySeedUid?: string
  displayNameSchemaUid?: string
  profileSchemaUid?: string
  uriSchemaUid?: string
  labelSchemaUid?: string
  linkSchemaUid?: string
  identityUids?: IdentitySchemaUids
  modelUids?: ModelUids | null
  /** For executor tests: alias for postSchemaUid */
  seedSchemaUid?: string
  /** For executor tests: one property schema from modelUids (e.g. string value) */
  propertySchemaUid?: string
}

const CONTRACT_NAME = 'SeedProtocolExtension'

export const deployToLocalHardhat = async (): Promise<ValuesStore> => {
  // Deploy SchemaRegistry
  console.log('Deploying SchemaRegistry')
  const schemaRegistryContract = await ethers.getContractFactory('SchemaRegistry') as SchemaRegistry__factory;
  const schemaRegistryDeployed = await schemaRegistryContract.deploy();

  await schemaRegistryContract.getDeployTransaction()

  const schemaRegistryAddress = await schemaRegistryDeployed.getAddress();
  console.log('SchemaRegistry deployed to:', schemaRegistryAddress);

  const schemaRegistry = new SchemaRegistry(schemaRegistryAddress);

  // Deploy EAS
  console.log('Deploying EAS')
  const easContract = await ethers.getContractFactory('EAS') as EAS__factory;
  const easContractDeployed = await easContract.deploy(schemaRegistryAddress);

  const easAddress = await easContractDeployed.getAddress();
  console.log('EAS deployed to:', easAddress);

  const eas = new EAS(easAddress);

  const [signer] = await ethers.getSigners();

  schemaRegistry.connect(signer);
  eas.connect(signer);
  console.log('Connected to SchemaRegistry and EAS');

  // Create NameASchema schema
  const nameASchemaUid = await getUid(schemaRegistry, nameASchemaDefEncoded)
  console.log('NameASchema UID:', nameASchemaUid);

  const modelUids = await processModelSchema({
    modelSchema,
    schemaRegistry,
    nameASchemaUid,
    eas,
  });
    console.log(modelUids.Post.properties.featureImageId)

  // Create Identity schema
  const identitySchemaUid = await getUid(schemaRegistry, identitySchemaDefEncoded)

  // Create Content schema
  const postSchemaUid = await getUid(schemaRegistry, postSchemaDefEncoded)

  // Create Version schema
  const versionSchemaUid = await getUid(schemaRegistry, versionSchemaDefEncoded)

  console.log(`nameASchemaUid: ${nameASchemaUid}`)
  console.log(`identitySchemaUid: ${identitySchemaUid}`)
  console.log(`postSchemaUid: ${postSchemaUid}`)
  console.log(`versionSchemaUid: ${versionSchemaUid}`)

  // Deploy SeedProtocol
  const SeedProtocol = await ethers.getContractFactory(CONTRACT_NAME);
  const seedProtocol = await upgrades.deployProxy(SeedProtocol, [
    easContractDeployed.target,
 ], { initializer: 'initialize', unsafeAllow: ['delegatecall']});

  if (!seedProtocol) {
    throw new Error('SeedProtocol not deployed');
  }

  await seedProtocol.waitForDeployment();

  console.log('SeedProtocol deployed to:', seedProtocol.target);
  const identitySeedUid = await createSeed(seedProtocol, identitySchemaUid, 'bytes32')
  const postSeedUid = await createSeed(seedProtocol, postSchemaUid, 'bytes32')

  console.log(`identityAttestationUid: ${identitySeedUid}`)
  console.log(`postSeedUid: ${postSeedUid}`)

  // Populate modelSchema with schema UIDs
  for (const modelName in modelSchema) {
    const model = modelSchema[modelName];
    model.info.schemaUid = modelUids[modelName].schemaUid;

    for (const propName in model.properties) {
      const propertyInfo = model.properties[propName];
      propertyInfo.schemaUid = modelUids[modelName].properties[propName].schemaUid;
    }
  }

  // const getEas = seedProtocol.getFunction(`getEas()`);
  //
  // if (!getEas) {
  //   throw new Error('Function fragment not found');
  // }
  //
  //
  // const transaction = await getEas.send({
  //   value: BigInt(0),
  //   // gasLimit: BigInt(1022881482n),
  //   gasLimit: 30000000n,
  // });
  //
  // const receipt = await transaction.wait()
  //
  // console.log('receipt', receipt)


  // for (const propName in byte32Props) {
  //   const schemaDefinition = `bytes32 ${propName}`
  //   const schemaDefinitionEncoded = ethers.encodeBytes32String(schemaDefinition)
  //   const schemaUid = await getUid(schemaRegistry, schemaDefinitionEncoded)
  //   propertyData[propName] = {
  //     schemaUid,
  //     schemaDefinition,
  //     dataType: 'bytes32',
  //   }
  // }
  //
  // for (const propName in stringProps) {
  //   const schemaDefinition = `string ${propName}`
  //   const schemaDefinitionEncoded = ethers.encodeBytes32String(schemaDefinition)
  //   const schemaUid = await getUid(schemaRegistry, schemaDefinitionEncoded)
  //   propertyData[propName] = {
  //     schemaUid,
  //     schemaDefinition,
  //     dataType: 'string',
  //   }
  // }



  // Executor-test aliases: seedSchemaUid = postSchemaUid; propertySchemaUid = first property from any model
  const seedSchemaUid = postSchemaUid
  let propertySchemaUid: string | undefined
  if (modelUids && typeof modelUids === 'object') {
    const firstModel = Object.values(modelUids)[0] as { properties?: Record<string, { schemaUid: string }> }
    const firstProp = firstModel?.properties && Object.values(firstModel.properties)[0]
    if (firstProp?.schemaUid) propertySchemaUid = firstProp.schemaUid
  }
  if (!propertySchemaUid) {
    const valueSchemaUid = await getUid(schemaRegistry, 'string value')
    propertySchemaUid = valueSchemaUid
  }

  return {
    schemaRegistry,
    schemaRegistryAddress,
    easAddress,
    eas,
    nameASchemaUid,
    identitySchemaUid,
    postSchemaUid,
    versionSchemaUid,
    seedSchemaUid,
    propertySchemaUid,
    seedProtocol,
    identitySeedUid,
    postSeedUid,
    modelUids,
  }
}
