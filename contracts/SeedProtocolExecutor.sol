// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IEAS.sol";
import {SeedPublishLib} from "./SeedPublishLib.sol";


// ============================================================================
// ERC-7579 Interfaces
// ============================================================================

/// @dev ERC-7579 module type IDs
uint256 constant MODULE_TYPE_VALIDATOR = 1;
uint256 constant MODULE_TYPE_EXECUTOR = 2;
uint256 constant MODULE_TYPE_FALLBACK = 3;
uint256 constant MODULE_TYPE_HOOK = 4;

/// @dev ERC-7579 call type constants
bytes1 constant CALLTYPE_SINGLE = 0x00;
bytes1 constant CALLTYPE_BATCH = 0x01;

/// @dev ERC-7579 exec type constants
bytes1 constant EXECTYPE_DEFAULT = 0x00;

/// @dev Represents an encoded execution mode (callType + execType + unused + modeSelector + modePayload)
type ModeCode is bytes32;

/// @dev Helper to encode a ModeCode
library ModeLib {
    function encodeSimpleSingle() internal pure returns (ModeCode) {
        return ModeCode.wrap(
            bytes32(abi.encodePacked(CALLTYPE_SINGLE, EXECTYPE_DEFAULT, bytes4(0), bytes4(0), bytes22(0)))
        );
    }

    function encodeSimpleBatch() internal pure returns (ModeCode) {
        return ModeCode.wrap(
            bytes32(abi.encodePacked(CALLTYPE_BATCH, EXECTYPE_DEFAULT, bytes4(0), bytes4(0), bytes22(0)))
        );
    }
}

/// @dev Execution struct for batch calls per ERC-7579
struct Execution {
    address target;
    uint256 value;
    bytes callData;
}

/// @dev Minimal ERC-7579 account interface that executor modules call back into
interface IERC7579Account {
    function executeFromExecutor(
        ModeCode mode,
        bytes calldata executionCalldata
    ) external payable returns (bytes[] memory returnData);

    function isModuleInstalled(
        uint256 moduleTypeId,
        address module,
        bytes calldata additionalContext
    ) external view returns (bool);
}

/// @dev ERC-7579 module interface - all modules must implement this
interface IERC7579Module {
    function onInstall(bytes calldata data) external;
    function onUninstall(bytes calldata data) external;
    function isModuleType(uint256 moduleTypeId) external view returns (bool);
}

// ============================================================================
// Seed Protocol Data Structures (unchanged from original)
// ============================================================================

struct PropertyToUpdateWithSeed {
    uint256 publishIndex;
    bytes32 propertySchemaUid;
}

struct PublishRequestData {
    string localId;
    bytes32 seedUid;
    bytes32 versionUid;
    bytes32 seedSchemaUid;
    bytes32 versionSchemaUid;
    bool seedIsRevocable;
    MultiAttestationRequest[] listOfAttestations;
    PropertyToUpdateWithSeed[] propertiesToUpdate;
}

struct CreatedAttestationResult {
    bytes32 schemaUid;
    bytes32 attestationUid;
}

// ============================================================================
// SeedProtocolExecutor - ERC-7579 Executor Module
// ============================================================================

/**
 * @title SeedProtocolExecutor
 * @notice An ERC-7579 executor module that creates EAS attestations on behalf of
 *         the smart account that installs it. The smart account becomes the
 *         msg.sender to EAS, and therefore the attester/owner of all attestations.
 *
 * @dev Architecture difference from the old thirdweb Extension pattern:
 *      - Old pattern: ManagedAccount delegatecalls into the extension, so
 *        address(this) == the account and msg.sender to EAS == the account.
 *      - New pattern: The executor module calls account.executeFromExecutor(),
 *        which causes the account to make the external call to EAS. The account
 *        is still msg.sender to EAS, preserving attestation ownership.
 *
 *      Every function acts on `msg.sender` as the account, so only the account
 *      itself (i.e. its admins or session keys allowed to target this module) can
 *      drive it. Publishing follows the same rules as the Seed extensions
 *      (SeedPublishLib): everything created is revocable, and cross-references
 *      must point at the current or a later request.
 *
 *      Value: only `multiPublish` is payable. `msg.value` is passed back to the
 *      account with the first EAS batch that needs it and the module never holds
 *      ETH; value no batch consumes is rejected.
 *
 *      This module is compatible with any ERC-7579 compliant smart account
 *      (thirdweb, Safe + Safe7579 adapter, Biconomy, ZeroDev, etc.) that marks a
 *      module installed before calling `onInstall` and uninstalled before calling
 *      `onUninstall`, as the ERC-7579 reference implementation does.
 */
contract SeedProtocolExecutor is IERC7579Module {

    // ========================================================================
    // Events
    // ========================================================================

    event CreatedAttestation(CreatedAttestationResult result);
    event SeedPublished(bytes32 seedUid, bytes32 versionUid);
    event ModuleInitialized(address indexed account, address indexed eas);
    event ModuleUninitialized(address indexed account);

    // ========================================================================
    // Errors
    // ========================================================================

    error AlreadyInitialized(address account);
    error NotInitialized(address account);
    error InvalidEASAddress();
    error AttestationFailed();
    error MultiAttestFailed();
    /// @dev `onInstall` called outside of the account installing this module.
    error NotInstalledOnAccount(address account);
    /// @dev `onUninstall` called outside of the account uninstalling this module.
    error StillInstalledOnAccount(address account);
    /// @dev `msg.value` that no EAS batch consumed; rejected so the module never holds ETH.
    error UnusedValue(uint256 value);

    // ========================================================================
    // Storage
    // ========================================================================

    /// @dev Per-account configuration. Each smart account that installs this
    ///      module gets its own EAS address mapping. This allows a single
    ///      deployed module contract to serve multiple accounts.
    mapping(address account => address eas) private _easForAccount;

    // ========================================================================
    // ERC-7579 Module Lifecycle
    // ========================================================================

    /// @inheritdoc IERC7579Module
    /// @dev Called by the smart account when installing this module.
    ///      `data` is abi.encode(address easAddress).
    ///      Only takes effect while the account reports this module as installed, so
    ///      a session key that can reach this module through the account can't
    ///      (re)initialize it with an EAS of its choosing.
    function onInstall(bytes calldata data) external override {
        if (!_isInstalledOn(msg.sender)) {
            revert NotInstalledOnAccount(msg.sender);
        }
        if (_easForAccount[msg.sender] != address(0)) {
            revert AlreadyInitialized(msg.sender);
        }

        address eas = abi.decode(data, (address));
        if (eas == address(0)) {
            revert InvalidEASAddress();
        }

        _easForAccount[msg.sender] = eas;

        emit ModuleInitialized(msg.sender, eas);
    }

    /// @inheritdoc IERC7579Module
    /// @dev Called by the smart account when uninstalling this module.
    ///      Only takes effect once the account no longer reports this module as
    ///      installed, so a session key can't wipe the configuration to break publishing.
    function onUninstall(bytes calldata) external override {
        if (_isInstalledOn(msg.sender)) {
            revert StillInstalledOnAccount(msg.sender);
        }

        delete _easForAccount[msg.sender];

        emit ModuleUninitialized(msg.sender);
    }

    /// @inheritdoc IERC7579Module
    function isModuleType(uint256 moduleTypeId) external pure override returns (bool) {
        return moduleTypeId == MODULE_TYPE_EXECUTOR;
    }

    /// @dev Returns true if this module has been initialized for the given account.
    function isInitialized(address account) external view returns (bool) {
        return _easForAccount[account] != address(0);
    }

    /// @dev Returns the EAS address configured for the given account.
    function getEAS(address account) external view returns (address) {
        return _easForAccount[account];
    }

    // ========================================================================
    // Seed Protocol Functions
    // ========================================================================

    /**
     * @notice Creates a (revocable) Seed attestation via the calling smart account.
     * @dev The caller must be the smart account that has this module installed.
     * @param schemaUid The schema UID for the seed attestation
     * @return seedUid The UID of the created attestation
     */
    function createSeed(bytes32 schemaUid) external returns (bytes32) {
        return _createSeed(msg.sender, _getEASOrRevert(msg.sender), schemaUid);
    }

    /**
     * @notice Creates a Version attestation referencing a seed, via the smart account.
     * @param seedUid The UID of the parent seed attestation
     * @param versionSchemaUid The schema UID for the version attestation
     * @return versionUid The UID of the created version attestation
     */
    function createVersion(bytes32 seedUid, bytes32 versionSchemaUid) external returns (bytes32) {
        return _createVersion(msg.sender, _getEASOrRevert(msg.sender), seedUid, versionSchemaUid);
    }

    /**
     * @notice Publishes a seed + version, creating either or both if they don't exist yet.
     * @dev Only the seed/version are created; use `multiPublish` for property attestations.
     *      `seedIsRevocable` is ignored: seeds are always revocable.
     * @param request The publish request data
     * @return seedUid The seed attestation UID (created or existing)
     * @return versionUid The version attestation UID (created or existing)
     */
    function publish(PublishRequestData memory request) external returns (bytes32, bytes32) {
        return _publish(msg.sender, _getEASOrRevert(msg.sender), request);
    }

    /**
     * @notice Batch publishes multiple seeds/versions and their property attestations.
     * @dev Same cross-reference rules as the Seed extensions (SeedPublishLib):
     *      - Each request's listOfAttestations gets its refUID updated to the new
     *        versionUid and is forced revocable
     *      - propertiesToUpdate injects a request's new seedUid into the current or
     *        a later request's attestation data
     * @param requests Array of publish request data
     * @return result The seed UID of each request
     */
    function multiPublish(
        PublishRequestData[] memory requests
    ) external payable returns (bytes32[] memory) {
        address account = msg.sender;
        address eas = _getEASOrRevert(account);
        uint256 value = msg.value;

        bytes32[] memory result = new bytes32[](requests.length);

        for (uint256 i = 0; i < requests.length; i++) {
            PublishRequestData memory requestToPublish = requests[i];

            // Create seed and/or version as needed
            (bytes32 newSeedUid, bytes32 newVersionUid) = _publish(account, eas, requestToPublish);

            // Update other requests that reference this request's new seedUid
            PropertyToUpdateWithSeed[] memory propertiesToUpdate = requestToPublish.propertiesToUpdate;
            for (uint256 l = 0; l < propertiesToUpdate.length; l++) {
                uint256 idx = propertiesToUpdate[l].publishIndex;
                SeedPublishLib.checkPublishIndex(idx, requests.length);
                SeedPublishLib.setSeedReference(
                    requests[idx].listOfAttestations,
                    i,
                    idx,
                    propertiesToUpdate[l].propertySchemaUid,
                    newSeedUid
                );
            }

            // Execute multiAttest via the smart account
            if (requestToPublish.listOfAttestations.length > 0) {
                SeedPublishLib.prepareProperties(requestToPublish.listOfAttestations, newVersionUid);

                bytes[] memory results = _executeOnAccount(
                    account,
                    eas,
                    value,
                    abi.encodeCall(IEAS.multiAttest, (requestToPublish.listOfAttestations))
                );
                value = 0;

                // executeFromExecutor reverts on failure with EXECTYPE_DEFAULT; an empty
                // result means a non-conforming account
                if (results.length == 0) {
                    revert MultiAttestFailed();
                }

                emit SeedPublished(newSeedUid, newVersionUid);
            }

            result[i] = newSeedUid;
        }

        if (value != 0) {
            revert UnusedValue(value);
        }

        return result;
    }

    /**
     * @notice Revokes an attestation made by the calling smart account.
     * @dev EAS only lets the original attester revoke, so this can only touch the
     *      account's own attestations. `msg.value` is passed through to EAS for
     *      payable resolvers; EAS refunds any excess to the account.
     *      Anything able to drive this module through the account (including a session
     *      key allowed to target it) can revoke the account's attestations.
     * @param request The EAS revocation request
     */
    function revoke(RevocationRequest memory request) external payable {
        address account = msg.sender;
        _executeOnAccount(account, _getEASOrRevert(account), msg.value, abi.encodeCall(IEAS.revoke, (request)));
    }

    /**
     * @notice Revokes multiple attestations made by the calling smart account, across schemas.
     * @dev Same rules as `revoke`.
     * @param multiRequests The EAS multi-revocation requests
     */
    function multiRevoke(MultiRevocationRequest[] memory multiRequests) external payable {
        address account = msg.sender;
        _executeOnAccount(
            account,
            _getEASOrRevert(account),
            msg.value,
            abi.encodeCall(IEAS.multiRevoke, (multiRequests))
        );
    }

    // ========================================================================
    // Internal Helpers
    // ========================================================================

    function _publish(
        address account,
        address eas,
        PublishRequestData memory request
    ) internal returns (bytes32 seedUid, bytes32 versionUid) {
        seedUid = request.seedUid;
        versionUid = request.versionUid;

        if (seedUid == bytes32(0)) {
            seedUid = _createSeed(account, eas, request.seedSchemaUid);
        }

        if (versionUid == bytes32(0)) {
            versionUid = _createVersion(account, eas, seedUid, request.versionSchemaUid);
        }
    }

    function _createSeed(address account, address eas, bytes32 schemaUid) internal returns (bytes32) {
        return _attest(account, eas, schemaUid, bytes32(0), abi.encode(schemaUid));
    }

    function _createVersion(
        address account,
        address eas,
        bytes32 seedUid,
        bytes32 versionSchemaUid
    ) internal returns (bytes32) {
        return _attest(account, eas, versionSchemaUid, seedUid, abi.encode(versionSchemaUid));
    }

    /// @dev Creates a revocable attestation as `account` and returns its UID.
    function _attest(
        address account,
        address eas,
        bytes32 schemaUid,
        bytes32 refUid,
        bytes memory data
    ) internal returns (bytes32 uid) {
        AttestationRequest memory request = AttestationRequest({
            schema: schemaUid,
            data: AttestationRequestData({
                recipient: address(0),
                expirationTime: 0,
                revocable: true,
                refUID: refUid,
                data: data,
                value: 0
            })
        });

        bytes[] memory results = _executeOnAccount(account, eas, 0, abi.encodeCall(IEAS.attest, (request)));

        uid = abi.decode(results[0], (bytes32));
        if (uid == bytes32(0)) {
            revert AttestationFailed();
        }

        emit CreatedAttestation(CreatedAttestationResult({
            schemaUid: schemaUid,
            attestationUid: uid
        }));
    }

    /// @dev Has `account` call `eas` with `value`, passing that value back to the account
    ///      with the call so the account never pays for it from its own balance.
    function _executeOnAccount(
        address account,
        address eas,
        uint256 value,
        bytes memory easCalldata
    ) internal returns (bytes[] memory) {
        return IERC7579Account(account).executeFromExecutor{value: value}(
            ModeLib.encodeSimpleSingle(),
            abi.encodePacked(eas, value, easCalldata)
        );
    }

    function _isInstalledOn(address account) internal view returns (bool) {
        return IERC7579Account(account).isModuleInstalled(MODULE_TYPE_EXECUTOR, address(this), "");
    }

    /// @dev Returns the EAS address for the account, or reverts if not initialized.
    function _getEASOrRevert(address account) internal view returns (address eas) {
        eas = _easForAccount[account];
        if (eas == address(0)) {
            revert NotInitialized(account);
        }
    }
}
