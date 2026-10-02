/**
 * Gas benchmark payload fixtures for multiPublish.
 * Placeholders (benchmark script substitutes with actual schema UIDs):
 *   __SEED_SCHEMA_UID__, __SEED_SCHEMA_UID_1__, __SEED_SCHEMA_UID_2__, __SEED_SCHEMA_UID_3__
 *   __VERSION_SCHEMA_UID__
 *   __PROPERTY_SCHEMA_UID__, __PROPERTY_SCHEMA_UID_1__, __PROPERTY_SCHEMA_UID_2__, __PROPERTY_SCHEMA_UID_3__
 */

export type GasPayload = {
  name: string;
  requests: unknown[];
};

/** 2 requests, 0 attestations each — baseline loop overhead */
export const minimal: GasPayload = {
  name: "minimal",
  requests: [
    {
      localId: "request-1",
      seedUid: "0x0000000000000000000000000000000000000000000000000000000000000000",
      versionUid: "0x0000000000000000000000000000000000000000000000000000000000000000",
      seedSchemaUid: "__SEED_SCHEMA_UID__",
      versionSchemaUid: "__VERSION_SCHEMA_UID__",
      seedIsRevocable: true,
      listOfAttestations: [],
      propertiesToUpdate: [],
    },
    {
      localId: "request-2",
      seedUid: "0x0000000000000000000000000000000000000000000000000000000000000000",
      versionUid: "0x0000000000000000000000000000000000000000000000000000000000000000",
      seedSchemaUid: "__SEED_SCHEMA_UID__",
      versionSchemaUid: "__VERSION_SCHEMA_UID__",
      seedIsRevocable: false,
      listOfAttestations: [],
      propertiesToUpdate: [],
    },
  ],
};

/** 1 request, 3 attestations — single publish with properties */
export const small: GasPayload = {
  name: "small",
  requests: [
    {
      localId: "request-with-props",
      seedUid: "0x0000000000000000000000000000000000000000000000000000000000000000",
      versionUid: "0x0000000000000000000000000000000000000000000000000000000000000000",
      seedSchemaUid: "__SEED_SCHEMA_UID__",
      versionSchemaUid: "__VERSION_SCHEMA_UID__",
      seedIsRevocable: true,
      listOfAttestations: [
        {
          schema: "__PROPERTY_SCHEMA_UID__",
          data: [
            {
              recipient: "0x0000000000000000000000000000000000000000",
              revocable: true,
              value: "0",
              refUID: "0x0000000000000000000000000000000000000000000000000000000000000000",
              expirationTime: "0",
              data:
                "0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000a70726f702d76616c756531000000000000000000000000000000000000000000",
            },
          ],
        },
        {
          schema: "__PROPERTY_SCHEMA_UID__",
          data: [
            {
              recipient: "0x0000000000000000000000000000000000000000",
              revocable: true,
              value: "0",
              refUID: "0x0000000000000000000000000000000000000000000000000000000000000000",
              expirationTime: "0",
              data:
                "0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000a70726f702d76616c756532000000000000000000000000000000000000000000",
            },
          ],
        },
        {
          schema: "__PROPERTY_SCHEMA_UID__",
          data: [
            {
              recipient: "0x0000000000000000000000000000000000000000",
              revocable: true,
              value: "0",
              refUID: "0x0000000000000000000000000000000000000000000000000000000000000000",
              expirationTime: "0",
              data:
                "0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000a70726f702d76616c756533000000000000000000000000000000000000000000",
            },
          ],
        },
      ],
      propertiesToUpdate: [],
    },
  ],
};

/** 2 requests, cross-ref via propertiesToUpdate (publishLocalId for Legacy, publishIndex for V2) */
export const medium: GasPayload = {
  name: "medium",
  requests: [
    {
      localId: "parent-request",
      seedUid: "0x0000000000000000000000000000000000000000000000000000000000000000",
      versionUid: "0x0000000000000000000000000000000000000000000000000000000000000000",
      seedSchemaUid: "__SEED_SCHEMA_UID__",
      versionSchemaUid: "__VERSION_SCHEMA_UID__",
      seedIsRevocable: true,
      listOfAttestations: [],
      propertiesToUpdate: [
        { publishLocalId: "child-request", propertySchemaUid: "__PROPERTY_SCHEMA_UID__" },
      ],
    },
    {
      localId: "child-request",
      seedUid: "0x0000000000000000000000000000000000000000000000000000000000000000",
      versionUid: "0x0000000000000000000000000000000000000000000000000000000000000000",
      seedSchemaUid: "__SEED_SCHEMA_UID__",
      versionSchemaUid: "__VERSION_SCHEMA_UID__",
      seedIsRevocable: true,
      listOfAttestations: [
        {
          schema: "__PROPERTY_SCHEMA_UID__",
          data: [
            {
              recipient: "0x0000000000000000000000000000000000000000",
              revocable: true,
              value: "0",
              refUID: "0x0000000000000000000000000000000000000000000000000000000000000000",
              expirationTime: "0",
              data:
                "0x0000000000000000000000000000000000000000000000000000000000000000",
            },
          ],
        },
      ],
      propertiesToUpdate: [],
    },
  ],
};

/** 4 requests, multiple attestations, multiple cross-refs — stress test */
export const large: GasPayload = {
  name: "large",
  requests: [
    {
      localId: "parent-1",
      seedUid: "0x0000000000000000000000000000000000000000000000000000000000000000",
      versionUid: "0x0000000000000000000000000000000000000000000000000000000000000000",
      seedSchemaUid: "__SEED_SCHEMA_UID__",
      versionSchemaUid: "__VERSION_SCHEMA_UID__",
      seedIsRevocable: true,
      listOfAttestations: [],
      propertiesToUpdate: [
        { publishLocalId: "child-1", propertySchemaUid: "__PROPERTY_SCHEMA_UID__" },
        { publishLocalId: "child-2", propertySchemaUid: "__PROPERTY_SCHEMA_UID__" },
      ],
    },
    {
      localId: "child-1",
      seedUid: "0x0000000000000000000000000000000000000000000000000000000000000000",
      versionUid: "0x0000000000000000000000000000000000000000000000000000000000000000",
      seedSchemaUid: "__SEED_SCHEMA_UID__",
      versionSchemaUid: "__VERSION_SCHEMA_UID__",
      seedIsRevocable: true,
      listOfAttestations: [
        {
          schema: "__PROPERTY_SCHEMA_UID__",
          data: [
            {
              recipient: "0x0000000000000000000000000000000000000000",
              revocable: true,
              value: "0",
              refUID: "0x0000000000000000000000000000000000000000000000000000000000000000",
              expirationTime: "0",
              data:
                "0x0000000000000000000000000000000000000000000000000000000000000000",
            },
          ],
        },
      ],
      propertiesToUpdate: [],
    },
    {
      localId: "child-2",
      seedUid: "0x0000000000000000000000000000000000000000000000000000000000000000",
      versionUid: "0x0000000000000000000000000000000000000000000000000000000000000000",
      seedSchemaUid: "__SEED_SCHEMA_UID__",
      versionSchemaUid: "__VERSION_SCHEMA_UID__",
      seedIsRevocable: false,
      listOfAttestations: [
        {
          schema: "__PROPERTY_SCHEMA_UID__",
          data: [
            {
              recipient: "0x0000000000000000000000000000000000000000",
              revocable: true,
              value: "0",
              refUID: "0x0000000000000000000000000000000000000000000000000000000000000000",
              expirationTime: "0",
              data:
                "0x0000000000000000000000000000000000000000000000000000000000000000",
            },
          ],
        },
        {
          schema: "__PROPERTY_SCHEMA_UID_2__",
          data: [
            {
              recipient: "0x0000000000000000000000000000000000000000",
              revocable: true,
              value: "0",
              refUID: "0x0000000000000000000000000000000000000000000000000000000000000000",
              expirationTime: "0",
              data:
                "0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000a6c617267652d76616c7565000000000000000000000000000000000000000000",
            },
          ],
        },
      ],
      propertiesToUpdate: [],
    },
    {
      localId: "standalone",
      seedUid: "0x0000000000000000000000000000000000000000000000000000000000000000",
      versionUid: "0x0000000000000000000000000000000000000000000000000000000000000000",
      seedSchemaUid: "__SEED_SCHEMA_UID__",
      versionSchemaUid: "__VERSION_SCHEMA_UID__",
      seedIsRevocable: true,
      listOfAttestations: [],
      propertiesToUpdate: [],
    },
  ],
};

/** 2 requests — real payload: Image + Post seeds, cross-ref via propertiesToUpdate (image property) */
export const real: GasPayload = {
  name: "real",
  requests: [
    {
      localId: "51IhR1FeXj",
      seedIsRevocable: true,
      versionSchemaUid: "__VERSION_SCHEMA_UID__",
      seedUid: "0x0000000000000000000000000000000000000000000000000000000000000000",
      seedSchemaUid: "__SEED_SCHEMA_UID_2__",
      versionUid: "0x0000000000000000000000000000000000000000000000000000000000000000",
      listOfAttestations: [
        {
          schema: "__VERSION_SCHEMA_UID__",
          data: [
            {
              recipient: "0x0000000000000000000000000000000000000000",
              revocable: true,
              value: "0",
              refUID: "0x0000000000000000000000000000000000000000000000000000000000000000",
              expirationTime: "0",
              data:
                "0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000002b5262727948706473626d71313249764a7356387952586d77797349435063304352434845796c4130474e67000000000000000000000000000000000000000000",
            },
          ],
        },
      ],
      propertiesToUpdate: [
        { publishLocalId: "qPxsBdhfmn", propertySchemaUid: "__PROPERTY_SCHEMA_UID_2__" },
      ],
    },
    {
      localId: "qPxsBdhfmn",
      seedUid: "0x0000000000000000000000000000000000000000000000000000000000000000",
      seedIsRevocable: true,
      seedSchemaUid: "__SEED_SCHEMA_UID_1__",
      versionSchemaUid: "__VERSION_SCHEMA_UID__",
      versionUid: "0x0000000000000000000000000000000000000000000000000000000000000000",
      listOfAttestations: [
        {
          schema: "__VERSION_SCHEMA_UID__",
          data: [
            {
              recipient: "0x0000000000000000000000000000000000000000",
              revocable: true,
              value: "0",
              refUID: "0x0000000000000000000000000000000000000000000000000000000000000000",
              expirationTime: "0",
              data:
                "0x000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000137477656574207769746820616e20696d61676500000000000000000000000000",
            },
          ],
        },
        {
          schema: "__PROPERTY_SCHEMA_UID_2__",
          data: [
            {
              recipient: "0x0000000000000000000000000000000000000000",
              revocable: true,
              value: "0",
              refUID: "0x0000000000000000000000000000000000000000000000000000000000000000",
              expirationTime: "0",
              data:
                "0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000a3531496852314665586a00000000000000000000000000000000000000000000",
            },
          ],
        },
      ],
      propertiesToUpdate: [],
    },
  ],
};

export const GAS_PAYLOADS: GasPayload[] = [minimal, small, medium, large, real];
