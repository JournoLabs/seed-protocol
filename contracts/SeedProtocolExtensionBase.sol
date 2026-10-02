// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IEAS.sol";
import {CreatedAttestationResult} from "../interfaces/ISeedProtocol.sol";
import {AccountPermissionsStorage} from "@thirdweb-dev/contracts/extension/upgradeable/AccountPermissions.sol";

/// @dev The one AccountCore getter the extension needs, called on the account itself.
interface IAccountEntryPoint {
    function entryPoint() external view returns (address);
}

/**
 * @title SeedProtocolExtensionBase
 * @notice Shared logic for Seed Protocol extensions on thirdweb ManagedAccounts.
 *
 * @dev Runs via delegatecall from the account's Router fallback: `address(this)` is the
 *      account and storage is the account's. The Router does no authorization, so every
 *      routed state-changing function must use `onlyAccountOrAdmin`.
 *
 *      Deploy as a plain contract (no proxy). The EAS address is an immutable, which lives
 *      in bytecode and so resolves correctly under delegatecall; changing it means deploying
 *      a new extension and calling `replaceExtension` on the factory.
 *
 *      All attestations created through `multiPublish` are forced revocable, so an account
 *      owner can always revoke anything published on their behalf, including by a delegate
 *      holding a session key.
 */
abstract contract SeedProtocolExtensionBase {

    event CreatedAttestation(CreatedAttestationResult result);
    event SeedPublished(bytes returnedDataFromEAS);

    error Unauthorized(address caller);
    error InvalidEAS(address eas);
    error AttestationFailed(bytes32 schemaUid);
    /// @dev A cross-reference (`propertiesToUpdate`) points outside the batch.
    error PublishIndexOutOfBounds(uint256 targetIndex, uint256 length);
    error UnknownPublishLocalId(string publishLocalId);
    /// @dev A cross-reference points at a request whose attestations were already submitted,
    ///      so the seed UID could never be written into them.
    error PublishTargetAlreadyAttested(uint256 requestIndex, uint256 targetIndex);
    /// @dev A cross-referenced property attestation has no data entry to write the seed UID into.
    error EmptyAttestationData(uint256 targetIndex, bytes32 propertySchemaUid);

    IEAS private immutable _eas;

    constructor(address eas_) {
        if (eas_.code.length == 0) revert InvalidEAS(eas_);
        _eas = IEAS(eas_);
    }

    /**
     * @dev Allowed callers, evaluated in the account's context:
     *      - the account itself: `execute`/`executeBatch` self-calls by admins or by session
     *        keys whose approved targets include the account (delegated publishing)
     *      - an account admin calling the account directly
     *      - the EntryPoint calling the account directly; it only does so after
     *        `validateUserOp` succeeds, and session keys are limited to `execute`/
     *        `executeBatch`, so this implies an admin-signed UserOp
     */
    modifier onlyAccountOrAdmin() {
        _checkCaller();
        _;
    }

    function getEas() external view returns (address) {
        return address(_eas);
    }

    /*///////////////////////////////////////////////////////////////
                            Internal functions
    //////////////////////////////////////////////////////////////*/

    function _checkCaller() internal view {
        if (msg.sender == address(this)) return;
        if (AccountPermissionsStorage.data().isAdmin[msg.sender]) return;
        if (msg.sender == IAccountEntryPoint(address(this)).entryPoint()) return;
        revert Unauthorized(msg.sender);
    }

    /// @dev Creates the seed and/or version when the request doesn't already reference them.
    function _publish(
        bytes32 seedUid,
        bytes32 versionUid,
        bytes32 seedSchemaUid,
        bytes32 versionSchemaUid
    ) internal returns (bytes32, bytes32) {
        if (seedUid == bytes32(0)) {
            seedUid = _attest(seedSchemaUid, bytes32(0), abi.encode(seedSchemaUid));
        }

        if (versionUid == bytes32(0)) {
            versionUid = _attest(versionSchemaUid, seedUid, abi.encode(versionSchemaUid));
        }

        return (seedUid, versionUid);
    }

    /**
     * @dev Writes `seedUid` into the first data entry of each `propertySchemaUid` attestation
     *      of the request at `targetIndex`. Cross-references are applied before the current
     *      request is attested, so targeting the current request (`targetIndex == requestIndex`)
     *      or a later one works; targeting an earlier one would be silently lost, so it reverts.
     */
    function _setSeedReference(
        MultiAttestationRequest[] memory targetAttestations,
        uint256 requestIndex,
        uint256 targetIndex,
        bytes32 propertySchemaUid,
        bytes32 seedUid
    ) internal pure {
        if (targetIndex < requestIndex) revert PublishTargetAlreadyAttested(requestIndex, targetIndex);

        for (uint256 n = 0; n < targetAttestations.length; n++) {
            if (targetAttestations[n].schema == propertySchemaUid) {
                if (targetAttestations[n].data.length == 0) revert EmptyAttestationData(targetIndex, propertySchemaUid);
                targetAttestations[n].data[0].data = abi.encode(seedUid);
            }
        }
    }

    /**
     * @dev Points every property attestation at `versionUid`, forces it revocable, and
     *      submits the batch to EAS. `value` is forwarded with this call and the remaining
     *      value is returned, so `msg.value` is spent at most once per `multiPublish`.
     */
    function _attestProperties(
        MultiAttestationRequest[] memory listOfAttestations,
        bytes32 versionUid,
        uint256 value
    ) internal returns (uint256 remainingValue) {
        bytes32[] memory uids;

        if (listOfAttestations.length > 0) {
            for (uint256 j = 0; j < listOfAttestations.length; j++) {
                AttestationRequestData[] memory data = listOfAttestations[j].data;
                for (uint256 k = 0; k < data.length; k++) {
                    data[k].refUID = versionUid;
                    data[k].revocable = true;
                }
            }

            uids = _eas.multiAttest{value: value}(listOfAttestations);
            value = 0;
        }

        // Same bytes as EAS's raw multiAttest return data, which this event carried before.
        emit SeedPublished(abi.encode(uids));

        return value;
    }

    function _attest(bytes32 schemaUid, bytes32 refUid, bytes memory data) private returns (bytes32 uid) {
        uid = _eas.attest(
            AttestationRequest({
                schema: schemaUid,
                data: AttestationRequestData({
                    recipient: address(0),
                    expirationTime: 0,
                    revocable: true,
                    refUID: refUid,
                    data: data,
                    value: 0
                })
            })
        );

        if (uid == bytes32(0)) revert AttestationFailed(schemaUid);

        emit CreatedAttestation(CreatedAttestationResult({schemaUid: schemaUid, attestationUid: uid}));
    }
}
