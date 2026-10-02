// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./SeedProtocolExtensionBase.sol";
import "../interfaces/ISeedProtocol.sol";

/// @notice Optimized SeedProtocolExtension using publishIndex (uint256) instead of publishLocalId (string)
/// @dev Gas-optimized: O(1) index lookup instead of O(n) string comparison in triple-nested loop.
///      Routed selectors: `multiPublish`, `getEas`. See SeedProtocolExtensionBase for the
///      execution context and access-control model.
contract SeedProtocolExtensionV2 is ISeedProtocol, SeedProtocolExtensionBase {

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

            // Update other requests that have properties that need to reference the newSeedUid
            // Gas-optimized: O(1) index lookup instead of O(n) string comparison
            PropertyToUpdateWithSeed[] memory propertiesToUpdate = requestToPublish.propertiesToUpdate;
            for (uint l = 0; l < propertiesToUpdate.length; l++) {
                PropertyToUpdateWithSeed memory propertyToUpdate = propertiesToUpdate[l];
                uint256 idx = propertyToUpdate.publishIndex;
                if (idx >= requests.length) revert PublishIndexOutOfBounds(idx, requests.length);
                _setSeedReference(
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
