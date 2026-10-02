// NOTE: Hardhat 2 script, not yet ported to Hardhat 3. It will be ported or replaced
// in the deploy branch (see docs/hardhat3-migration-plan.md, H9). Expect it to fail until then.

import {
  AttestationRequestData, EAS, MultiAttestationRequest,
  SchemaEncoder,
  SchemaItem,
  SchemaRegistry,
  ZERO_ADDRESS, ZERO_BYTES,
  ZERO_BYTES32
} from '@ethereum-attestation-service/eas-sdk'
// import { ethers }                                                 from 'hardhat'
import { Contract, encodeBytes32String, decodeBytes32String, } from 'ethers'
import {
  DataFnForPropertyNameType,
  DataFnParams,
  IdentityData, IdentitySchemaUids,
  Link,
  ModelSchema,
  PropertyInfo,
  SchemaUidKey
}                   from '../types'
import { testPublishRequestData }                              from './test_data'
import { ethers }                                              from 'hardhat'


const storageProvider: PropertyInfo[] = [
  {
    name: 'storage_provider',
    type: 'bytes32',
    ref: 'StorageProvider',
  }
]

const uri: PropertyInfo[] = [
  {
    name: 'uri',
    type: 'string',
  }
]

const name: PropertyInfo[] = [
  {
    name: 'name',
    type: 'string',
  }
]

const storageProviderTransactionId: PropertyInfo[] = [
  {
    name: 'transactionId',
    type: 'string',
  }
]

export const generateId = (): string => {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    const charactersLength = characters.length;
    for (let i = 0; i < 10; i++) {
        result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }

  return result
}

export const modelSchema: ModelSchema = {
  Identity: {
    info: {
        name: 'identity',
        type: 'bytes32',
      },
    properties: {
      display_name: {
          name: 'display_name',
          type: 'string',
        },
      profile: {
          name: 'profile',
          type: 'string',
      },
      avatarImage: {
          name: 'avatar_image_id',
          type: 'bytes32',
          ref: 'Image',
        },
      coverImage: {
          name: 'cover_image_id',
          type: 'bytes32',
          ref: 'Image',
        },
      links: {
          name: 'link_ids',
          type: 'bytes32[]',
          ref: 'Link',
        },
    }
  },
  Post: {
    info: {
        name: 'post',
        type: 'bytes32',
    },
    properties: {
      title: {
          name: 'title',
          type: 'string',
      },
      summary: {
          name: 'summary',
          type: 'string',
      },
      authorIdentityIds: {
          name: 'author_identity_ids',
          type: 'bytes32[]',
          ref: 'Identity',
          list: true,
      },
      featureImageId: {
          name: 'feature_image_id',
          type: 'bytes32',
          ref: 'Image',
      },
      thumbnailImageId: {
          name: 'thumbnail_image_id',
          type: 'bytes32',
          ref: 'Image',
        },
      storageTransactionId: {
          name: 'storage_transaction_id',
          type: 'string',
      },
    }

  },
  Image: {
    info: {
        name: 'image',
        type: 'bytes32',
      },
    properties: {
      sha256: {
          name: 'sha256',
          type: 'string',
      },
      storageTransactionId: {
          name: 'storage_transaction_id',
          type: 'string',
      },
      uri: {
          name: 'uri',
          type: 'string',
      },
    }
  },
  Version: {
    info: {
        name: 'version',
        type: 'bytes32',
    },
    properties: {
    }
  },
}

export const byte32Props = [
  'identity',
  'post',
  'image',
  'version',
  'avatar_image_id',
  'cover_image_id',
  'feature_image_id',
]

export const stringProps = [
  'display_name',
  'profile',
  'title',
  'summary',
  'hash',
  'uri',
  'label',
]


export const versionSchemaDefinition = 'bytes32 version'
export const identitySchemaDefinition = 'bytes32 identity'
export const postSchemaDefinition     = 'bytes32 post'
export const nameASchemaDefinition    = 'bytes32 schemaId,string name'
export const displayNameSchemaDefinition = 'string display_name'
export const uriSchemaDefinition = 'string uri'
export const labelSchemaDefinition = 'string label'
export const linkSchemaDefinition = 'bytes32 label,bytes32 uri'
export const profileSchemaDefinition = 'string profile'
export const titleSchemaDefinition = 'string title'
export const summarySchemaDefinition = 'string summary'

export const versionSchemaDefEncoded = encodeBytes32String(versionSchemaDefinition)
export const identitySchemaDefEncoded = encodeBytes32String(identitySchemaDefinition)
export const postSchemaDefEncoded     = encodeBytes32String(postSchemaDefinition)
export const nameASchemaDefEncoded    = encodeBytes32String(nameASchemaDefinition)
export const displayNameSchemaDefEncoded = encodeBytes32String(displayNameSchemaDefinition)
export const uriSchemaDefEncoded = encodeBytes32String(uriSchemaDefinition)
export const labelSchemaDefEncoded = encodeBytes32String(labelSchemaDefinition)
export const linkSchemaDefEncoded = encodeBytes32String(linkSchemaDefinition)
export const profileSchemaDefEncoded = encodeBytes32String(profileSchemaDefinition)
export const titleSchemaDefEncoded = encodeBytes32String(titleSchemaDefinition)
export const summarySchemaDefEncoded = encodeBytes32String(summarySchemaDefinition)

export const displayNameEncoder = new SchemaEncoder('string display_name')
export const uriEncoder = new SchemaEncoder('string uri')
export const labelEncoder = new SchemaEncoder('string label')
export const linkEncoder = new SchemaEncoder('bytes32 label,bytes32 uri')
export const profileEncoder = new SchemaEncoder('string profile')
export const summaryEncoder = new SchemaEncoder('string summary')

export const proxySchemaDefinition = encodeBytes32String("bool PROXY");

export const defaultAttestationRequestData: AttestationRequestData = {
  recipient: ZERO_ADDRESS,
  expirationTime: BigInt(0),
  revocable: true,
  refUID: ZERO_BYTES32,
  data: ZERO_BYTES,
  value: BigInt(0),
}

export const dataFnForPropertyName: DataFnForPropertyNameType = {
  display_name: (value: DataFnParams) => {
    const data = [
      {
        name: 'display_name',
        value,
        type: 'string',
      }
    ]
    return displayNameEncoder.encodeData(data)
  },
  profile: (value: DataFnParams) => {
    const data = [
      {
        name: 'profile',
        value,
        type: 'string',
      }
    ]
    return profileEncoder.encodeData(data)
  },
  avatar_image_uri: (value: DataFnParams) => {
    const data = [
      {
        name: 'uri',
        value,
        type: 'string',
      }
    ]
    return uriEncoder.encodeData(data)
  },
  label: (value: DataFnParams) => {
    const data = [
      {
        name: 'label',
        value,
        type: 'string',
      }
    ]
    return labelEncoder.encodeData(data)
  },
  uri: (value: DataFnParams) => {
    const data = [
      {
        name: 'uri',
        value,
        type: 'string',
      }
    ]
    return uriEncoder.encodeData(data)
  },
  link: (value: DataFnParams) => {
    if (!isLink(value)) {
      return ''
    }
    const data = [
      {
        name: 'label',
        value: value.label || '',
        type: 'string',
      },
      {
        name: 'uri',
        value: value.uri || '',
        type: 'string',
      }
    ]
    return linkEncoder.encodeData(data)
  },
  links: (value: DataFnParams) => {
    if (!isLinkArray(value)) {
      return ''
    }
    const data = value.map((link) => {
      if (!link || !dataFnForPropertyName.link) {
        throw new Error(`No label or uri found for link ${link}`)
      }
      return {
        name: 'link',
        value: dataFnForPropertyName.link(link as Link),
        type: 'bytes32',
      }
    })
    return linkEncoder.encodeData(data)
  }
}

export const createPropertyData = async ( propertyName: SchemaUidKey, identityUids: IdentitySchemaUids,): Promise<MultiAttestationRequest[]> => {
  if (!Object.hasOwn(identityUids, propertyName)) {
    return []
  }
  const valueToSave = identityData[propertyName]
  if (!valueToSave) {
    throw new Error(`No value found for ${propertyName}`)
  }
  if (propertyName === 'links' || Array.isArray(valueToSave)) {
    const linkData = valueToSave as Link[]
    const linkDataToSave = linkData.map((link) => {
      return {
        label: link.label,
        uri: link.uri,
      }
    })
    const labelsData: MultiAttestationRequest = {
      schema: identityUids.label as string,
      data: [],
    }
    const urisData: MultiAttestationRequest = {
      schema: identityUids.uri as string,
      data: [],
    }
    for ( let i = 0; i < linkDataToSave.length; i++ ) {
      const link = linkDataToSave[i]
      if (!dataFnForPropertyName.label || ! dataFnForPropertyName.uri || !link.label || !link.uri) {
        throw new Error(`No label or uri found for link ${i}`)
      }
      const labelBuffer = Buffer.from(link.label)
      if (labelBuffer.length > 32) {
        throw new Error(`Value ${link.label} is too long. Max length is 32 bytes.`)
      }
      const uriBuffer = Buffer.from(link.uri)
      if (uriBuffer.length > 32) {
        throw new Error(`Value ${link.uri} is too long. Max length is 32 bytes.`)
      }
      labelsData.data.push({
        ...defaultAttestationRequestData,
        data: dataFnForPropertyName.label(link.label),
      })
      urisData.data.push({
        ...defaultAttestationRequestData,
        data: dataFnForPropertyName.uri(link.uri),
      })
    }
    return [
      labelsData,
      urisData,
    ]
  }
  if (!dataFnForPropertyName || !dataFnForPropertyName[propertyName]) {
    throw new Error(`No data function found for ${propertyName}`)
  }
  return [
    {
      schema: identityUids[propertyName] as string,
      data: [
        {
          ...defaultAttestationRequestData,
          data: dataFnForPropertyName[propertyName](valueToSave),
        }
      ]
    }
  ]
}

export const registerProxySchema = async (schemaRegistry: SchemaRegistry): Promise<string> => {
  const revocable = true;

  const transaction = await schemaRegistry.register({
    schema: proxySchemaDefinition,
    resolverAddress: ZERO_ADDRESS,
    revocable,
  });

  const proxySchemaUid = await transaction.wait()

  console.log(`proxySchemaUid: ${proxySchemaUid}`)

  return proxySchemaUid
}


export const getUid = async (schemaRegistry: SchemaRegistry, schemaDefinition: string): Promise<string> => {
  let uid = ''
  try {
    const tx = await schemaRegistry.register({
      schema: schemaDefinition,
      resolverAddress: ZERO_ADDRESS,
      revocable: true,
    });

    uid = await tx.wait()

  } catch (error) {
    const message = (error as Error)?.message ?? String(error)
    if (message.includes('AlreadyExists')) {
      uid = SchemaRegistry.getSchemaUID(schemaDefinition, ZERO_ADDRESS, true)
    } else {
      console.log(`Error getting UID for schemaDefinition: ${schemaDefinition}`)
      console.log(error)
    }
  }
  return uid
}

export const createAndNameSchema = async (schemaRegistry: SchemaRegistry, nameASchemaUid: string, nameASchemaEncoder: SchemaEncoder, eas: EAS, name: string): Promise<string> => {

  const schemaUid = await registerProxySchema(schemaRegistry)

  const nameSchemaData: SchemaItem[] = [
    {name: 'schemaId', value: schemaUid, type: 'bytes32'},
    {name: 'name', value: name, type: 'string'}
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

  console.log(tx)

  return schemaUid
}

export const identityData: IdentityData = {
  display_name: 'Test User',
  profile: 'Here are three or four sentences about me.',
  avatar_image_uri: 'https://api.dicebear.com/7.x/identicon/svg?seed=Test%20User',
  links: [
    {
      label: 'Twitter',
      uri: 'https://twitter.com/testuser',
    },
    {
      label: 'Website',
      uri: 'https://testuser.com',
    },
  ],
}

export enum SchemaTypes {
  Version = 0,
  Identity = 1,
  Content = 2,
}

export const isLink = (value: DataFnParams): value is Link => {
  return (value as Link).label !== undefined && (value as Link).uri !== undefined
}

export const isLinkArray = (value: DataFnParams): value is Link[] => {
  return Array.isArray(value) && isLink(value[0])
}

export const isString = (value: DataFnParams): value is string => {
  return typeof value === 'string'
}

export const createSeed = async ( seedProtocol: Contract, schemaUid: string, schemaTypeFormat: 'bytes32' | 'uint8',): Promise<string> => {
  const createSeedMethod = seedProtocol.getFunction(`createSeed(bytes32,bool)`);

  if (!createSeedMethod) {
    throw new Error('Function fragment not found');
  }


  const overrides: { value: bigint; gasLimit?: bigint } = {
    value: BigInt(0),
  };
  // Cap gas for networks (e.g. local Hardhat) that enforce a tx gas cap below 30M
  const TX_GAS_CAP = 16_777_216;
  const estimated = await createSeedMethod.estimateGas(schemaUid, true, { value: 0n }).catch(() => null);
  if (estimated != null && estimated <= BigInt(TX_GAS_CAP)) {
    overrides.gasLimit = estimated;
  } else {
    overrides.gasLimit = BigInt(TX_GAS_CAP);
  }
  const transaction = await createSeedMethod.send(schemaUid, true, overrides);

  // const [signer] = await ethers.getSigners();
  //
  // console.log('Calling createSeed with schemaUid: ', schemaUid)
  //
  // const result = await seedProtocol.createSeed(signer.getAddress(), schemaUid, true)
  //
  // const receipt = await result.wait()

  // console.log('===== done =====')
  // console.log(done)
  // console.log('===== /done =====')

  const receipt = await transaction.wait();

  if (!receipt) {
    throw new Error('Transaction failed');
  }

  if (!receipt.logs || receipt.logs.length === 0) {
    throw new Error('No logs found');
  }

  let attestationUid = ''

  for (const log of receipt.logs) {
    // attestationUid = log.data
    if (log.args) {
      console.log(seedProtocol.interface.parseLog(log)?.args)
      const args = seedProtocol.interface.parseLog(log)?.args.toArray()
      if (args && args.length > 0) {
        for (let i = 0; i < args.length; i++) {
          const value = args[i]
          console.log(`${value} length is ${value.length}`)
          console.log('Array.isArray(value)', Array.isArray(value))
            if (Array.isArray(value) && value[1].length === 66) {
              attestationUid = value[1]
            }
        }
      }
    }
  }

  return attestationUid
}

