// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./SeedProtocolExtensionBase.sol";
import "../interfaces/ISeedProtocol.sol";

/// @notice Publishes Seeds, their Versions and property attestations from a thirdweb ManagedAccount.
/// @dev A cross-reference (`propertiesToUpdate`) names its target by `publishIndex`, the target's
///      position in `requests`; `localId` is carried for the client and not read. Routed
///      selectors: `multiPublish`, `getEas`. See SeedProtocolExtensionBase for the execution
///      context and access-control model, and SeedPublishLib for the cross-reference checks.
contract SeedProtocolExtension is ISeedProtocol, SeedProtocolExtensionBase {

    constructor(address eas_) SeedProtocolExtensionBase(eas_) {}

    /*///////////////////////////////////////////////////////////////
                            External functions
    //////////////////////////////////////////////////////////////*/

    /// @dev `seedIsRevocable` is ignored: seeds are always revocable (see SeedProtocolExtensionBase).
    function multiPublish(
        PublishRequestData[] memory requests
    ) external payable onlyAccountOrAdmin returns (bytes32[] memory) {
        bytes32[] memory result = new bytes32[](requests.length);
        uint256 value = msg.value;

        for (uint i = 0; i < requests.length; i++) {
            PublishRequestData memory requestToPublish = requests[i];

            (bytes32 newSeedUid, bytes32 newVersionUid) = _publish(
                requestToPublish.seedUid,
                requestToPublish.versionUid,
                requestToPublish.seedSchemaUid,
                requestToPublish.versionSchemaUid
            );

            // Write newSeedUid into the cross-referenced property of each target request
            PropertyToUpdateWithSeed[] memory propertiesToUpdate = requestToPublish.propertiesToUpdate;
            for (uint l = 0; l < propertiesToUpdate.length; l++) {
                PropertyToUpdateWithSeed memory propertyToUpdate = propertiesToUpdate[l];
                uint256 idx = propertyToUpdate.publishIndex;
                SeedPublishLib.checkPublishIndex(idx, requests.length);
                SeedPublishLib.setSeedReference(
                    requests[idx].listOfAttestations,
                    i,
                    idx,
                    propertyToUpdate.propertySchemaUid,
                    newSeedUid
                );
            }

            value = _attestProperties(requestToPublish.listOfAttestations, newVersionUid, value);

            result[i] = newSeedUid;
        }

        return result;
    }
}
