// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {MultiAttestationRequest, AttestationRequestData} from "../interfaces/IEAS.sol";

/**
 * @title SeedPublishLib
 * @notice multiPublish request preparation shared by the Seed extensions and the executor
 *         module, so every publishing path enforces the same rules.
 */
library SeedPublishLib {

    /// @dev A cross-reference (`propertiesToUpdate`) points outside the batch.
    error PublishIndexOutOfBounds(uint256 targetIndex, uint256 length);
    error UnknownPublishLocalId(string publishLocalId);
    /// @dev A cross-reference points at a request whose attestations were already submitted,
    ///      so the seed UID could never be written into them.
    error PublishTargetAlreadyAttested(uint256 requestIndex, uint256 targetIndex);
    /// @dev A cross-referenced property attestation has no data entry to write the seed UID into.
    error EmptyAttestationData(uint256 targetIndex, bytes32 propertySchemaUid);
    /// @dev The target request has no attestation with the cross-referenced property schema,
    ///      so the seed UID would silently not be written anywhere.
    error PropertyToUpdateNotFound(uint256 requestIndex, uint256 targetIndex, bytes32 propertySchemaUid);
    /// @dev The target request has more than one data entry with the cross-referenced schema, so
    ///      writing the seed UID into one (or all) of them would overwrite other client data.
    error AmbiguousPropertyToUpdate(uint256 targetIndex, bytes32 propertySchemaUid);

    /**
     * @dev Points property attestations without a client-supplied `refUID` at `versionUid`
     *      (a non-zero `refUID` from the client is preserved), and forces every one revocable
     *      so an account owner can always revoke what was published on their behalf
     *      (including by a delegate holding a session key).
     */
    function prepareProperties(MultiAttestationRequest[] memory listOfAttestations, bytes32 versionUid) internal pure {
        for (uint256 j = 0; j < listOfAttestations.length; j++) {
            AttestationRequestData[] memory data = listOfAttestations[j].data;
            for (uint256 k = 0; k < data.length; k++) {
                if (data[k].refUID == bytes32(0)) {
                    data[k].refUID = versionUid;
                }
                data[k].revocable = true;
            }
        }
    }

    /**
     * @dev Replaces the client's placeholder in the one `propertySchemaUid` data entry of the
     *      request at `targetIndex` with `seedUid`. Reverts rather than touch anything else: the
     *      target must hold exactly one such entry. References fill single-value relations only;
     *      list relations are resolved client-side (the contract can't tell an encoded list from
     *      an encoded placeholder string, so it relies on the client for that).
     *
     *      Cross-references are applied before the current request is attested, so targeting
     *      the current request (`targetIndex == requestIndex`) or a later one works; targeting
     *      an earlier one would be silently lost, so it reverts.
     */
    function setSeedReference(
        MultiAttestationRequest[] memory targetAttestations,
        uint256 requestIndex,
        uint256 targetIndex,
        bytes32 propertySchemaUid,
        bytes32 seedUid
    ) internal pure {
        if (targetIndex < requestIndex) revert PublishTargetAlreadyAttested(requestIndex, targetIndex);

        bool found = false;
        uint256 matchIndex;
        for (uint256 n = 0; n < targetAttestations.length; n++) {
            if (targetAttestations[n].schema == propertySchemaUid) {
                uint256 entries = targetAttestations[n].data.length;
                if (entries == 0) revert EmptyAttestationData(targetIndex, propertySchemaUid);
                if (found || entries > 1) revert AmbiguousPropertyToUpdate(targetIndex, propertySchemaUid);
                found = true;
                matchIndex = n;
            }
        }
        if (!found) revert PropertyToUpdateNotFound(requestIndex, targetIndex, propertySchemaUid);

        targetAttestations[matchIndex].data[0].data = abi.encode(seedUid);
    }

    /// @dev Reverts unless `targetIndex` is inside a batch of `length` requests.
    function checkPublishIndex(uint256 targetIndex, uint256 length) internal pure {
        if (targetIndex >= length) revert PublishIndexOutOfBounds(targetIndex, length);
    }
}
