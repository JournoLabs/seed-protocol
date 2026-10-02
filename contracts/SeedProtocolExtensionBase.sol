// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IEAS.sol";
import {CreatedAttestationResult} from "../interfaces/ISeedProtocol.sol";
import {SeedAccountAuth} from "./SeedAccountAuth.sol";
import {SeedPublishLib} from "./SeedPublishLib.sol";

/**
 * @title SeedProtocolExtensionBase
 * @notice Shared logic for Seed Protocol extensions on thirdweb ManagedAccounts.
 *
 * @dev Runs via delegatecall from the account's Router fallback (see SeedAccountAuth). The
 *      Router does no authorization, so every routed state-changing function must use
 *      `onlyAccountOrAdmin`.
 *
 *      Deploy as a plain contract (no proxy). The EAS address is an immutable, which lives
 *      in bytecode and so resolves correctly under delegatecall; changing it means deploying
 *      a new extension and calling `replaceExtension` on the factory.
 *
 *      All attestations created through `multiPublish` are forced revocable, so an account
 *      owner can always revoke anything published on their behalf, including by a delegate
 *      holding a session key.
 */
abstract contract SeedProtocolExtensionBase is SeedAccountAuth {

    event CreatedAttestation(CreatedAttestationResult result);
    event SeedPublished(bytes returnedDataFromEAS);

    error InvalidEAS(address eas);
    error AttestationFailed(bytes32 schemaUid);

    IEAS private immutable _eas;

    constructor(address eas_) {
        if (eas_.code.length == 0) revert InvalidEAS(eas_);
        _eas = IEAS(eas_);
    }

    /// @dev Self-calls (admins, or session keys allowed to target the account), account
    ///      admins and the EntryPoint. See SeedAccountAuth.
    modifier onlyAccountOrAdmin() {
        _checkAccountOrAdmin();
        _;
    }

    function getEas() external view returns (address) {
        return address(_eas);
    }

    /*///////////////////////////////////////////////////////////////
                            Internal functions
    //////////////////////////////////////////////////////////////*/

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
     * @dev Points every property attestation at `versionUid`, forces it revocable
     *      (SeedPublishLib.prepareProperties), and submits the batch to EAS. `value` is forwarded with this call and the remaining
     *      value is returned, so `msg.value` is spent at most once per `multiPublish`.
     */
    function _attestProperties(
        MultiAttestationRequest[] memory listOfAttestations,
        bytes32 versionUid,
        uint256 value
    ) internal returns (uint256 remainingValue) {
        bytes32[] memory uids;

        if (listOfAttestations.length > 0) {
            SeedPublishLib.prepareProperties(listOfAttestations, versionUid);

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
