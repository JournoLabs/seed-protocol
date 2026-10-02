// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;


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
}

/// @dev ERC-7579 module interface - all modules must implement this
interface IERC7579Module {
    function onInstall(bytes calldata data) external;
    function onUninstall(bytes calldata data) external;
    function isModuleType(uint256 moduleTypeId) external view returns (bool);
}

// ============================================================================
// EAS Interfaces (unchanged from original)
// ============================================================================

struct AttestationRequestData {
    address recipient;
    uint64 expirationTime;
    bool revocable;
    bytes32 refUID;
    bytes data;
    uint256 value;
}

struct AttestationRequest {
    bytes32 schema;
    AttestationRequestData data;
}

struct MultiAttestationRequest {
    bytes32 schema;
    AttestationRequestData[] data;
}

interface IEAS_SeedProtocol {
    function attest(AttestationRequest calldata request) external payable returns (bytes32);
    function multiAttest(MultiAttestationRequest[] calldata multiRequests) external payable returns (bytes32[] memory);
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
 *      This module is compatible with any ERC-7579 compliant smart account
 *      (thirdweb, Safe + Safe7579 adapter, Biconomy, ZeroDev, etc.)
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
    ///      `data` is abi.encode(address easAddress)
    function onInstall(bytes calldata data) external override {
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
    function onUninstall(bytes calldata) external override {
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
     * @notice Creates a Seed attestation via the calling smart account.
     * @dev The caller must be the smart account that has this module installed.
     *      This function builds the EAS.attest() calldata, then calls
     *      account.executeFromExecutor() so the account makes the EAS call.
     *      The account is msg.sender to EAS → the account owns the attestation.
     * @param schemaUid The schema UID for the seed attestation
     * @param revocable Whether the attestation is revocable
     * @return seedUid The UID of the created attestation
     */
    function createSeed(
        bytes32 schemaUid,
        bool revocable
    ) public payable returns (bytes32) {
        address account = msg.sender;
        address eas = _getEASOrRevert(account);

        // Build the EAS attestation request
        AttestationRequestData memory seedData = AttestationRequestData({
            recipient: address(0),
            expirationTime: 0,
            revocable: revocable,
            refUID: bytes32(0),
            data: abi.encode(schemaUid),
            value: uint256(0)
        });

        AttestationRequest memory seedRequest = AttestationRequest({
            schema: schemaUid,
            data: seedData
        });

        // Encode the call to EAS.attest()
        bytes memory easCalldata = abi.encodeWithSelector(
            IEAS_SeedProtocol.attest.selector,
            seedRequest
        );

        // Execute via the smart account using single-call mode
        bytes[] memory results = IERC7579Account(account).executeFromExecutor(
            ModeLib.encodeSimpleSingle(),
            abi.encodePacked(eas, uint256(msg.value), easCalldata)
        );

        // Decode the returned attestation UID
        bytes32 seedUid = abi.decode(results[0], (bytes32));
        if (seedUid == bytes32(0)) {
            revert AttestationFailed();
        }

        emit CreatedAttestation(CreatedAttestationResult({
            schemaUid: schemaUid,
            attestationUid: seedUid
        }));

        return seedUid;
    }

    /**
     * @notice Creates a Version attestation referencing a seed, via the smart account.
     * @param seedUid The UID of the parent seed attestation
     * @param versionSchemaUid The schema UID for the version attestation
     * @return versionUid The UID of the created version attestation
     */
    function createVersion(
        bytes32 seedUid,
        bytes32 versionSchemaUid
    ) public payable returns (bytes32) {
        address account = msg.sender;
        address eas = _getEASOrRevert(account);

        AttestationRequestData memory versionData = AttestationRequestData({
            recipient: address(0),
            expirationTime: 0,
            revocable: true,
            refUID: seedUid,
            data: abi.encode(versionSchemaUid),
            value: uint256(0)
        });

        AttestationRequest memory versionRequest = AttestationRequest({
            schema: versionSchemaUid,
            data: versionData
        });

        bytes memory easCalldata = abi.encodeWithSelector(
            IEAS_SeedProtocol.attest.selector,
            versionRequest
        );

        bytes[] memory results = IERC7579Account(account).executeFromExecutor(
            ModeLib.encodeSimpleSingle(),
            abi.encodePacked(eas, uint256(msg.value), easCalldata)
        );

        bytes32 versionUid = abi.decode(results[0], (bytes32));
        if (versionUid == bytes32(0)) {
            revert AttestationFailed();
        }

        emit CreatedAttestation(CreatedAttestationResult({
            schemaUid: versionSchemaUid,
            attestationUid: versionUid
        }));

        return versionUid;
    }

    /**
     * @notice Publishes a seed + version, creating either or both if they don't exist yet.
     * @param request The publish request data
     * @return seedUid The seed attestation UID (created or existing)
     * @return versionUid The version attestation UID (created or existing)
     */
    function publish(
        PublishRequestData memory request
    ) public payable returns (bytes32, bytes32) {
        bytes32 seedUid = request.seedUid;
        bytes32 versionUid = request.versionUid;

        if (seedUid == bytes32(0)) {
            seedUid = createSeed(request.seedSchemaUid, request.seedIsRevocable);
        }

        if (seedUid != bytes32(0) && versionUid == bytes32(0)) {
            versionUid = createVersion(seedUid, request.versionSchemaUid);
        }

        return (seedUid, versionUid);
    }

    /**
     * @notice Batch publishes multiple seeds/versions and their property attestations.
     * @dev Preserves the same cross-reference logic from the original extension:
     *      - Each request's listOfAttestations gets its refUID updated to the new versionUid
     *      - propertiesToUpdate allows one request's newly created seedUid to be
     *        injected into another request's attestation data
     * @param requests Array of publish request data
     * @return result Array of bytes32 (reserved for future use)
     */
    function multiPublish(
        PublishRequestData[] memory requests
    ) public payable returns (bytes32[] memory) {
        address account = msg.sender;
        address eas = _getEASOrRevert(account);

        bytes32[] memory result = new bytes32[](requests.length);

        for (uint256 i = 0; i < requests.length; i++) {
            PublishRequestData memory requestToPublish = requests[i];

            // Create seed and/or version as needed
            (bytes32 newSeedUid, bytes32 newVersionUid) = publish(requestToPublish);

            // Update the current request's attestations with newVersionUid as refUID
            for (uint256 j = 0; j < requestToPublish.listOfAttestations.length; j++) {
                MultiAttestationRequest memory attestationRequest = requestToPublish.listOfAttestations[j];
                for (uint256 k = 0; k < attestationRequest.data.length; k++) {
                    attestationRequest.data[k].refUID = newVersionUid;
                }
            }

            // Update other requests that reference this request's new seedUid
            PropertyToUpdateWithSeed[] memory propertiesToUpdate = requestToPublish.propertiesToUpdate;
            for (uint256 l = 0; l < propertiesToUpdate.length; l++) {
                PropertyToUpdateWithSeed memory propertyToUpdate = propertiesToUpdate[l];
                uint256 idx = propertyToUpdate.publishIndex;
                require(idx < requests.length, "Invalid publish index");
                for (uint256 n = 0; n < requests[idx].listOfAttestations.length; n++) {
                    if (requests[idx].listOfAttestations[n].schema == propertyToUpdate.propertySchemaUid) {
                        requests[idx].listOfAttestations[n].data[0].data = abi.encode(newSeedUid);
                    }
                }
            }

            // Execute multiAttest via the smart account
            if (requestToPublish.listOfAttestations.length > 0) {
                bytes memory easCalldata = abi.encodeWithSelector(
                    IEAS_SeedProtocol.multiAttest.selector,
                    requestToPublish.listOfAttestations
                );

                bytes[] memory results = IERC7579Account(account).executeFromExecutor(
                    ModeLib.encodeSimpleSingle(),
                    abi.encodePacked(eas, uint256(msg.value), easCalldata)
                );

                // Verify the call succeeded (executeFromExecutor reverts on failure
                // with EXECTYPE_DEFAULT, but we check for empty return as extra safety)
                if (results.length == 0) {
                    revert MultiAttestFailed();
                }

                emit SeedPublished(newSeedUid, newVersionUid);
            }

            result[i] = newSeedUid;
        }

        return result;
    }

    // ========================================================================
    // Internal Helpers
    // ========================================================================

    /// @dev Returns the EAS address for the account, or reverts if not initialized.
    function _getEASOrRevert(address account) internal view returns (address eas) {
        eas = _easForAccount[account];
        if (eas == address(0)) {
            revert NotInitialized(account);
        }
    }
}
