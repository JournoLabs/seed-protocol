// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./SeedProtocolExtensionBase.sol";
import "../interfaces/ISeedProtocolLegacy.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

/// @notice Legacy SeedProtocolExtension using string-based publishLocalId (pre publishIndex optimization)
/// @dev Routed selectors: `multiPublish`, `getEas`. See SeedProtocolExtensionBase for the
///      execution context and access-control model.
contract SeedProtocolExtension is ISeedProtocolLegacy, SeedProtocolExtensionBase {

    constructor(address eas_) SeedProtocolExtensionBase(eas_) {}

    /*///////////////////////////////////////////////////////////////
                            External functions
    //////////////////////////////////////////////////////////////*/

    /// @dev `seedIsRevocable` is ignored: seeds are always revocable (see SeedProtocolExtensionBase).
    function multiPublish(
        PublishRequestDataLegacy[] memory requests
    ) external payable onlyAccountOrAdmin returns (bytes32[] memory) {
        bytes32[] memory result = new bytes32[](requests.length);
        uint256 value = msg.value;

        for (uint i = 0; i < requests.length; i++) {
            PublishRequestDataLegacy memory requestToPublish = requests[i];

            (bytes32 newSeedUid, bytes32 newVersionUid) = _publish(
                requestToPublish.seedUid,
                requestToPublish.versionUid,
                requestToPublish.seedSchemaUid,
                requestToPublish.versionSchemaUid
            );

            // Update other requests that have properties that need to reference the newSeedUid
            PropertyToUpdateWithSeedLegacy[] memory propertiesToUpdate = requestToPublish.propertiesToUpdate;
            // For each property, we find the corresponding request and update the property's value as the seedUid
            for (uint l = 0; l < propertiesToUpdate.length; l++) {
                PropertyToUpdateWithSeedLegacy memory propertyToUpdate = propertiesToUpdate[l];
                for (uint m = 0; m < requests.length; m++) {
                    PublishRequestDataLegacy memory targetForUpdate = requests[m];
                    if (Strings.equal(targetForUpdate.localId, propertyToUpdate.publishLocalId)) {
                        for (uint n = 0; n < targetForUpdate.listOfAttestations.length; n++) {
                            MultiAttestationRequest memory attestationRequest = targetForUpdate.listOfAttestations[n];
                            if (attestationRequest.schema == propertyToUpdate.propertySchemaUid) {
                                attestationRequest.data[0].data = abi.encode(newSeedUid);
                            }
                        }
                    }
                }
            }

            value = _attestProperties(requestToPublish.listOfAttestations, newVersionUid, value);

            result[i] = newSeedUid;
        }

        return result;
    }
}
