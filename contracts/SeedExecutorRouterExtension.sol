// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IEAS} from "../interfaces/IEAS.sol";
import {SeedAccountAuth} from "./SeedAccountAuth.sol";
import {
    ModeCode,
    ModeLib,
    MODULE_TYPE_EXECUTOR,
    IERC7579Module
} from "./SeedProtocolExecutor.sol";

library SeedExecutorRouterStorage {
    /// @custom:storage-location erc7201:extensions.seedprotocol.executor-router.storage
    bytes32 public constant POSITION = keccak256(abi.encode(uint256(keccak256("extensions.seedprotocol.executor-router.storage")) - 1)) & ~bytes32(uint256(0xff));

    struct Data {
        /// @dev Whether the account has installed the Seed executor module.
        bool installed;
    }

    function data() internal pure returns (Data storage data_) {
        bytes32 position = POSITION;
        assembly {
            data_.slot := position
        }
    }
}

/**
 * @title SeedExecutorRouterExtension
 * @notice Lets a thirdweb ManagedAccount use SeedProtocolExecutor by providing the slice of
 *         ERC-7579 the executor relies on: `executeFromExecutor` and `isModuleInstalled`.
 *
 * @dev Runs via delegatecall from the account's Router fallback (see SeedAccountAuth).
 *      Deploy as a plain contract and register it on the ManagedAccountFactory with the
 *      selectors `installSeedExecutor`, `uninstallSeedExecutor`, `isModuleInstalled`,
 *      `getSeedExecutor` and `executeFromExecutor`.
 *
 *      Both the executor and EAS are immutables chosen by whoever deploys and registers
 *      this extension (the factory admin). Account admins only opt in or out, so they
 *      can't be talked into installing a different module.
 *
 *      `executeFromExecutor` is deliberately narrow. Only the installed Seed executor may
 *      call it; only for a single call; only to EAS `attest`/`multiAttest` (no revocation,
 *      plan D8); and only with exactly the value the executor sent along, so the account
 *      never pays for the executor out of its own balance.
 *
 *      Ordering contract with SeedProtocolExecutor: the module is marked installed before
 *      `onInstall` and uninstalled before `onUninstall`, which is how the executor tells
 *      a real (un)install from a session key calling those functions directly.
 */
contract SeedExecutorRouterExtension is SeedAccountAuth {

    event SeedExecutorInstalled(address indexed executor);
    event SeedExecutorUninstalled(address indexed executor);

    error InvalidAddress(address addr);
    error SeedExecutorAlreadyInstalled();
    error SeedExecutorNotInstalled();
    error NotSeedExecutor(address caller);
    error UnsupportedExecutionMode(ModeCode mode);
    error TargetNotAllowed(address target);
    error SelectorNotAllowed(bytes4 selector);
    error ValueMismatch(uint256 encodedValue, uint256 sentValue);

    /// @dev abi.encodePacked(address target, uint256 value, bytes4 selector)
    uint256 private constant MIN_EXECUTION_CALLDATA_LENGTH = 20 + 32 + 4;

    address private immutable _eas;
    address private immutable _executor;

    constructor(address eas_, address executor_) {
        if (eas_.code.length == 0) revert InvalidAddress(eas_);
        if (executor_.code.length == 0) revert InvalidAddress(executor_);
        _eas = eas_;
        _executor = executor_;
    }

    /*///////////////////////////////////////////////////////////////
                        Install / uninstall (admin only)
    //////////////////////////////////////////////////////////////*/

    /// @notice Installs the Seed executor on this account, configured with this extension's EAS.
    function installSeedExecutor() external {
        _checkAdminOrEntryPoint();
        SeedExecutorRouterStorage.Data storage data = SeedExecutorRouterStorage.data();
        if (data.installed) revert SeedExecutorAlreadyInstalled();

        data.installed = true;
        IERC7579Module(_executor).onInstall(abi.encode(_eas));

        emit SeedExecutorInstalled(_executor);
    }

    /// @notice Uninstalls the Seed executor; it can no longer act for this account.
    function uninstallSeedExecutor() external {
        _checkAdminOrEntryPoint();
        SeedExecutorRouterStorage.Data storage data = SeedExecutorRouterStorage.data();
        if (!data.installed) revert SeedExecutorNotInstalled();

        data.installed = false;
        IERC7579Module(_executor).onUninstall("");

        emit SeedExecutorUninstalled(_executor);
    }

    /*///////////////////////////////////////////////////////////////
                                Views
    //////////////////////////////////////////////////////////////*/

    /// @notice ERC-7579 `isModuleInstalled`, for the single module this extension supports.
    function isModuleInstalled(
        uint256 moduleTypeId,
        address module,
        bytes calldata
    ) external view returns (bool) {
        return moduleTypeId == MODULE_TYPE_EXECUTOR
            && module == _executor
            && SeedExecutorRouterStorage.data().installed;
    }

    /// @notice The executor module this extension trusts, and the EAS it may call.
    function getSeedExecutor() external view returns (address executor, address eas) {
        return (_executor, _eas);
    }

    /*///////////////////////////////////////////////////////////////
                            Execution
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice ERC-7579 `executeFromExecutor`, restricted to the Seed executor calling EAS.
     * @param mode Must be single call type, default exec type, no selector/payload
     * @param executionCalldata abi.encodePacked(address target, uint256 value, bytes callData)
     * @return returnData A single entry: EAS's return data
     */
    function executeFromExecutor(
        ModeCode mode,
        bytes calldata executionCalldata
    ) external payable returns (bytes[] memory returnData) {
        if (msg.sender != _executor || !SeedExecutorRouterStorage.data().installed) {
            revert NotSeedExecutor(msg.sender);
        }
        if (ModeCode.unwrap(mode) != ModeCode.unwrap(ModeLib.encodeSimpleSingle())) {
            revert UnsupportedExecutionMode(mode);
        }
        if (executionCalldata.length < MIN_EXECUTION_CALLDATA_LENGTH) {
            revert SelectorNotAllowed(bytes4(0));
        }

        address target = address(bytes20(executionCalldata[0:20]));
        uint256 value = uint256(bytes32(executionCalldata[20:52]));
        bytes calldata callData = executionCalldata[52:];
        bytes4 selector = bytes4(callData[0:4]);

        if (target != _eas) revert TargetNotAllowed(target);
        if (selector != IEAS.attest.selector && selector != IEAS.multiAttest.selector) {
            revert SelectorNotAllowed(selector);
        }
        if (value != msg.value) revert ValueMismatch(value, msg.value);

        (bool success, bytes memory result) = target.call{value: value}(callData);
        if (!success) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }

        returnData = new bytes[](1);
        returnData[0] = result;
    }
}
