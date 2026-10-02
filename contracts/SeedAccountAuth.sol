// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AccountPermissionsStorage} from "@thirdweb-dev/contracts/extension/upgradeable/AccountPermissions.sol";

/// @dev The one AccountCore getter the extensions need, called on the account itself.
interface IAccountEntryPoint {
    function entryPoint() external view returns (address);
}

/**
 * @title SeedAccountAuth
 * @notice Caller checks for extensions that run via delegatecall from a thirdweb
 *         ManagedAccount's Router fallback, where `address(this)` is the account and
 *         storage is the account's. The Router does no authorization itself.
 *
 * @dev Who can produce each `msg.sender` in the account's context:
 *      - `address(this)`: the account calling itself via `execute`/`executeBatch`. Admins,
 *        and also any session key whose approved targets include the account.
 *      - the EntryPoint: only after `validateUserOp` succeeds. Session keys are limited to
 *        `execute`/`executeBatch`, so a direct EntryPoint call implies an admin signer.
 *      - an admin address: an admin EOA calling the account directly.
 */
abstract contract SeedAccountAuth {

    error Unauthorized(address caller);

    /// @dev For actions delegates may take (publishing): self-calls, admins, EntryPoint.
    function _checkAccountOrAdmin() internal view {
        if (msg.sender == address(this)) return;
        if (_isAccountAdmin(msg.sender)) return;
        if (msg.sender == _entryPoint()) return;
        revert Unauthorized(msg.sender);
    }

    /// @dev For admin-only actions: admins and EntryPoint, but not self-calls, which a
    ///      session key can make. Admins call the account directly, or send a UserOp whose
    ///      callData is the function itself rather than `execute(account, ...)`.
    function _checkAdminOrEntryPoint() internal view {
        if (_isAccountAdmin(msg.sender)) return;
        if (msg.sender == _entryPoint()) return;
        revert Unauthorized(msg.sender);
    }

    function _isAccountAdmin(address who) internal view returns (bool) {
        return AccountPermissionsStorage.data().isAdmin[who];
    }

    function _entryPoint() internal view returns (address) {
        return IAccountEntryPoint(address(this)).entryPoint();
    }
}
