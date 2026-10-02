// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @dev Test-only: pulls the real thirdweb ManagedAccount stack into the Hardhat
///      build so extensions can be exercised through the Router's delegatecall,
///      the same way they run on-chain. Not deployed anywhere.

import "@thirdweb-dev/contracts/prebuilts/account/managed/ManagedAccountFactory.sol";
import "@thirdweb-dev/contracts/prebuilts/account/utils/AccountExtension.sol";
import "@thirdweb-dev/contracts/prebuilts/account/utils/Entrypoint.sol";
