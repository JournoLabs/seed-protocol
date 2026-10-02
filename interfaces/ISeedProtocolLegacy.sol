// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import {Signature, MultiAttestationRequest} from "./IEAS.sol";

/// @notice Legacy interface with string-based publishLocalId (pre publishIndex optimization)
struct CreateSeedRequestLegacy {
    bytes32 schemaUid;
    bool revocable;
    Signature signature;
}

struct PropertyToUpdateWithSeedLegacy {
    string publishLocalId;
    bytes32 propertySchemaUid;
}

struct QueuedUpdateLegacy {
    string publishLocalId;
    bytes32 propertySchemaUid;
    bytes32 createdSeedUid;
}

struct PublishRequestDataLegacy {
    string localId;
    bytes32 seedUid;
    bytes32 seedSchemaUid;
    bytes32 versionUid;
    bytes32 versionSchemaUid;
    bool seedIsRevocable;
    MultiAttestationRequest[] listOfAttestations;
    PropertyToUpdateWithSeedLegacy[] propertiesToUpdate;
}

struct PublishReturnDataLegacy {
    bytes32 seedUid;
    bytes32 versionUid;
}

struct CreatedAttestationResultLegacy {
    bytes32 schemaUid;
    bytes32 attestationUid;
}

interface ISeedProtocolLegacy {

}
