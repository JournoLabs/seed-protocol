// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title MockERC7579Account
 * @notice A minimal ERC-7579 compatible smart account for local testing.
 *
 *         This implements just enough of the ERC-7579 account spec to test
 *         executor modules end-to-end:
 *           - installModule / uninstallModule with onInstall/onUninstall callbacks
 *           - executeFromExecutor with single-call and batch-call modes
 *           - Owner-gated module management
 *
 *         This is NOT a production account. It has no ERC-4337 integration,
 *         no signature validation, no entry point. It exists purely to test
 *         the executor ↔ account ↔ EAS call flow locally.
 */

/// @dev ERC-7579 module type IDs
uint256 constant MODULE_TYPE_VALIDATOR = 1;
uint256 constant MODULE_TYPE_EXECUTOR = 2;
uint256 constant MODULE_TYPE_FALLBACK = 3;
uint256 constant MODULE_TYPE_HOOK = 4;

/// @dev Call type bytes (first byte of ModeCode)
bytes1 constant CALLTYPE_SINGLE = 0x00;
bytes1 constant CALLTYPE_BATCH = 0x01;

/// @dev Minimal module interface for install/uninstall callbacks
interface IERC7579Module {
    function onInstall(bytes calldata data) external;
    function onUninstall(bytes calldata data) external;
    function isModuleType(uint256 moduleTypeId) external view returns (bool);
}

/// @dev ModeCode is a bytes32 encoding execution mode per ERC-7579
type ModeCode is bytes32;

contract MockERC7579Account {

    // ========================================================================
    // Events (per ERC-7579)
    // ========================================================================

    event ModuleInstalled(uint256 moduleTypeId, address module);
    event ModuleUninstalled(uint256 moduleTypeId, address module);
    event Executed(address target, uint256 value, bytes data, bytes result);

    // ========================================================================
    // Errors
    // ========================================================================

    error OnlyOwner();
    error ModuleAlreadyInstalled(uint256 moduleTypeId, address module);
    error ModuleNotInstalled(uint256 moduleTypeId, address module);
    error OnlyInstalledExecutor();
    error UnsupportedCallType(bytes1 callType);
    error ExecutionFailed(address target, bytes returnData);

    // ========================================================================
    // State
    // ========================================================================

    address public owner;

    /// @dev Tracks installed modules: moduleTypeId => module address => installed
    mapping(uint256 => mapping(address => bool)) private _installedModules;

    // ========================================================================
    // Constructor
    // ========================================================================

    constructor(address _owner) {
        owner = _owner;
    }

    // ========================================================================
    // Modifiers
    // ========================================================================

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier onlyInstalledExecutor() {
        if (!_installedModules[MODULE_TYPE_EXECUTOR][msg.sender]) {
            revert OnlyInstalledExecutor();
        }
        _;
    }

    // ========================================================================
    // Receive ETH
    // ========================================================================

    receive() external payable {}

    // ========================================================================
    // Module Management (ERC-7579)
    // ========================================================================

    /**
     * @notice Install a module on this account.
     * @param moduleTypeId The ERC-7579 module type (1=validator, 2=executor, etc.)
     * @param module The module contract address
     * @param initData Data passed to the module's onInstall()
     */
    function installModule(
        uint256 moduleTypeId,
        address module,
        bytes calldata initData
    ) external onlyOwner {
        if (_installedModules[moduleTypeId][module]) {
            revert ModuleAlreadyInstalled(moduleTypeId, module);
        }

        // Verify the module claims to be the correct type
        require(
            IERC7579Module(module).isModuleType(moduleTypeId),
            "Module type mismatch"
        );

        _installedModules[moduleTypeId][module] = true;

        // Call onInstall on the module
        IERC7579Module(module).onInstall(initData);

        emit ModuleInstalled(moduleTypeId, module);
    }

    /**
     * @notice Uninstall a module from this account.
     * @param moduleTypeId The ERC-7579 module type
     * @param module The module contract address
     * @param deInitData Data passed to the module's onUninstall()
     */
    function uninstallModule(
        uint256 moduleTypeId,
        address module,
        bytes calldata deInitData
    ) external onlyOwner {
        if (!_installedModules[moduleTypeId][module]) {
            revert ModuleNotInstalled(moduleTypeId, module);
        }

        _installedModules[moduleTypeId][module] = false;

        // Call onUninstall on the module
        IERC7579Module(module).onUninstall(deInitData);

        emit ModuleUninstalled(moduleTypeId, module);
    }

    /**
     * @notice Check if a module is installed.
     */
    function isModuleInstalled(
        uint256 moduleTypeId,
        address module,
        bytes calldata /* additionalContext */
    ) external view returns (bool) {
        return _installedModules[moduleTypeId][module];
    }

    // ========================================================================
    // Execution (ERC-7579)
    // ========================================================================

    /**
     * @notice Execute a call on behalf of this account, triggered by an installed executor module.
     * @dev Only installed executor modules (type 2) can call this.
     *
     *      Supports two call types from the ModeCode:
     *        - CALLTYPE_SINGLE (0x00): executionCalldata = abi.encodePacked(target, value, calldata)
     *        - CALLTYPE_BATCH  (0x01): executionCalldata = abi.encode(Execution[])
     *
     * @param mode The encoded execution mode (see ERC-7579 ModeCode)
     * @param executionCalldata The encoded call(s) to execute
     * @return returnData Array of return data from each call
     */
    function executeFromExecutor(
        ModeCode mode,
        bytes calldata executionCalldata
    ) external payable onlyInstalledExecutor returns (bytes[] memory returnData) {
        // Extract callType from the first byte of mode
        bytes1 callType = bytes1(ModeCode.unwrap(mode));

        if (callType == CALLTYPE_SINGLE) {
            return _executeSingle(executionCalldata);
        } else if (callType == CALLTYPE_BATCH) {
            return _executeBatch(executionCalldata);
        } else {
            revert UnsupportedCallType(callType);
        }
    }

    // ========================================================================
    // Owner-initiated execution (for test convenience)
    // ========================================================================

    /**
     * @notice Allows the owner to call an installed executor module's functions
     *         through this account. This simulates what would normally happen
     *         via a UserOperation in a real ERC-4337 setup.
     * @param target The contract to call (typically the executor module)
     * @param value ETH to send
     * @param data The calldata (e.g., abi.encodeWithSelector for createSeed, publish, etc.)
     */
    function execute(
        address target,
        uint256 value,
        bytes calldata data
    ) external payable onlyOwner returns (bytes memory) {
        (bool success, bytes memory result) = target.call{value: value}(data);
        if (!success) {
            // Bubble up the revert reason
            if (result.length > 0) {
                assembly {
                    revert(add(result, 32), mload(result))
                }
            }
            revert ExecutionFailed(target, result);
        }

        emit Executed(target, value, data, result);
        return result;
    }

    // ========================================================================
    // Internal execution helpers
    // ========================================================================

    /**
     * @dev Execute a single call.
     *      Encoding per ERC-7579: abi.encodePacked(address target, uint256 value, bytes calldata)
     *        - bytes[0:20]   = target address
     *        - bytes[20:52]  = uint256 value
     *        - bytes[52:]    = calldata to forward
     */
    function _executeSingle(
        bytes calldata executionCalldata
    ) internal returns (bytes[] memory returnData) {
        // Decode the packed encoding
        address target = address(bytes20(executionCalldata[0:20]));
        uint256 value = uint256(bytes32(executionCalldata[20:52]));
        bytes calldata callData = executionCalldata[52:];

        (bool success, bytes memory result) = target.call{value: value}(callData);
        if (!success) {
            if (result.length > 0) {
                assembly {
                    revert(add(result, 32), mload(result))
                }
            }
            revert ExecutionFailed(target, result);
        }

        emit Executed(target, value, callData, result);

        returnData = new bytes[](1);
        returnData[0] = result;
    }

    /**
     * @dev Execute a batch of calls.
     *      Encoding per ERC-7579: abi.encode(Execution[])
     *      where Execution = (address target, uint256 value, bytes callData)
     */
    struct Execution {
        address target;
        uint256 value;
        bytes callData;
    }

    function _executeBatch(
        bytes calldata executionCalldata
    ) internal returns (bytes[] memory returnData) {
        Execution[] memory executions = abi.decode(executionCalldata, (Execution[]));
        returnData = new bytes[](executions.length);

        for (uint256 i = 0; i < executions.length; i++) {
            (bool success, bytes memory result) = executions[i].target.call{
                value: executions[i].value
            }(executions[i].callData);

            if (!success) {
                if (result.length > 0) {
                    assembly {
                        revert(add(result, 32), mload(result))
                    }
                }
                revert ExecutionFailed(executions[i].target, result);
            }

            emit Executed(executions[i].target, executions[i].value, executions[i].callData, result);
            returnData[i] = result;
        }
    }
}
