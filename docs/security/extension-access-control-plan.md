# Seed Protocol extension access-control fix plan

Branch: `fix/extension-access-control`
Scope: OP Sepolia only, test users only. No forged-attestation cleanup is required.

## 1. Findings being fixed

| ID | Severity | Contract | Issue |
|----|----------|----------|-------|
| F1 | Critical | `SeedProtocolExtension`, `SeedProtocolExtensionV2` | `multiPublish` has no access control. The thirdweb Router `fallback()` delegatecalls into the extension with no auth, so anyone can make any Seed account attest arbitrary EAS data (any schema/recipient/refUID, `revocable: false`) as itself. |
| F2 | High | same | `setEas` is unprotected (guard commented out). Anyone can redirect an account's EAS to an arbitrary contract, breaking publishing or capturing `msg.value`. |
| F3 | Medium | same | Each account's EAS lives in *account* storage and is zero until `setEas` is called. `initialize()` only ran on the proxy's own storage, never on accounts. That's why `setEas` had to be publicly routed. |
| F4 | Medium | same | Extensions are deployed behind OZ Transparent proxies (`deployProxy`). A delegatecall into a proxy reads ERC-1967 slots from the account's storage, which is fragile. The extension inherits `OwnableUpgradeable`/`Initializable`, whose sequential storage would alias account storage if ever touched under delegatecall. |
| F5 | Low | same | `createSeed`, `createVersion` and `publish` are `public` with no auth. They aren't routed today but would be exploitable if ever added to the router. |
| F6 | Medium | `SeedProtocolExecutor` | `msg.value` mishandling. The executor keeps the ETH sent to it (no withdraw), then tells the account to send `msg.value` again from its own balance on every `createSeed`/`createVersion`/`multiAttest`. The account pays N× value and ETH gets stuck in the module. |
| F7 | — | thirdweb ManagedAccount | No `executeFromExecutor`, so `SeedProtocolExecutor` can't be used with existing accounts. |
| F8 | — | `SeedProtocolExecutor` | No revocation support (`revoke`/`multiRevoke`). |
| F9 | Low | both | Cross-reference robustness: `propertiesToUpdate` pointing at an already-processed request is a silent no-op, and an empty `data[]` panics with index-out-of-bounds instead of a clear error. |

## 2. Design decisions

### D1: Remove `setEas`; EAS becomes an immutable of the extension
The EAS address is passed to the extension's **constructor** and stored as an `immutable`. Immutables live in bytecode, so they resolve correctly under delegatecall.

Why not just guard `setEas`: session keys reach the account via `execute(account, …)` (a self-call), and admin UserOps built by the thirdweb SDK take the same path. Under delegatecall, `msg.sender == address(this)` can't tell an admin from a session key whose approved targets include the account. A guarded `setEas` would still let any such session key redirect EAS. With an immutable there's nothing to redirect.

This also fixes F3: no per-account initialization step. Changing EAS means deploying a new extension and calling `replaceExtension`, which is a factory-admin action.

### D2: Caller policy for publishing
`multiPublish` is allowed when `msg.sender` is one of:
- `address(this)`: the account calling itself via `execute`/`executeBatch`. This is the session-key path; it requires the account address in the key's `approvedTargets`.
- the account's EntryPoint: the account only receives these calls after `validateUserOp` succeeds, and `isValidSigner` rejects session keys for anything other than `execute`/`executeBatch`. So a direct EntryPoint → `multiPublish` call implies an admin signer.
- an account admin (`AccountPermissionsStorage.isAdmin[msg.sender]`): an admin EOA calling the account directly.

### D3: Extensions are plain, non-upgradeable contracts
- No proxy, no `Initializable`, no `OwnableUpgradeable`.
- Upgrades happen at the router level via `ManagedAccountFactory.replaceExtension` (`EXTENSION_ROLE`).
- The full `AccountPermissions` contract is no longer inherited. A small internal helper reads `isAdmin` from thirdweb's namespaced storage slot (`0x3181e7…2def00`).

### D4: Shared base contract
`SeedProtocolExtensionBase` (abstract) holds:
- the auth modifier
- the EAS immutable and `getEas()`
- internal `_createSeed`/`_createVersion`/`_publish`
- shared `msg.value` forwarding

`SeedProtocolExtension` (legacy, string `publishLocalId`) and `SeedProtocolExtensionV2` (uint `publishIndex`) only implement their own `multiPublish` cross-reference logic. Both get the fix and can't drift apart.

### D5: Executor path via a dedicated Router extension
`SeedExecutorRouterExtension` is added to the ManagedAccountFactory. It exposes:

| Function | Who may call | Behavior |
|----------|--------------|----------|
| `installSeedExecutor(address module)` | admin or EntryPoint only (**not** self, per D1) | stores `module` in namespaced account storage, then calls `module.onInstall(abi.encode(EAS))` |
| `uninstallSeedExecutor()` | admin or EntryPoint only | calls `onUninstall`, clears storage |
| `getSeedExecutor()` | anyone (view) | returns the installed module |
| `executeFromExecutor(ModeCode, bytes)` | installed module only | see constraints below |

Constraints on `executeFromExecutor`:
- **single call type** and default exec type only;
- **target == EAS** (immutable);
- **selector allowlist**: `attest`, `multiAttest`, `revoke`, `multiRevoke`;
- **value == msg.value**, so the account never spends its own balance on the executor's behalf.

The trust model matches D2: a session key that can reach the executor can attest (and revoke) as the account, and nothing else.

### D6: Executor fixes
- **`msg.value`**: received exactly once. It's forwarded via `executeFromExecutor{value: …}` on the first EAS call that needs it, and 0 on the rest. Internal `_createSeed`/`_createVersion` take an explicit value. The module never holds ETH: it asserts its balance is unchanged at the end, and has no `receive`.
- **Revocation**: add `revoke(RevocationRequest)` and `multiRevoke(MultiRevocationRequest[])`, routed through the same account → EAS path. EAS itself enforces that only the attester can revoke.

## 3. Work breakdown (one commit each)

1. **Test harness for real thirdweb accounts.** Add `contracts/test/ThirdwebHarness.sol` importing `EntryPoint`, `ManagedAccountFactory` and `ManagedAccount`. Add `test/fixtures/managedAccountFixture.js`, which:
   - deploys EAS, SchemaRegistry, EntryPoint and the factory;
   - registers extensions;
   - creates an account owned by `admin`;
   - provides helpers to grant session keys and to send UserOps through `EntryPoint.handleOps`.

   Existing tests call the extension directly, which can't catch F1–F4.
2. **Regression tests for F1/F2 (expected to fail).** A stranger calling `account.multiPublish` and `account.setEas` succeeds today. Commit these as `it.skip`/pending, then flip them on in step 3.
3. **`SeedProtocolExtensionBase` + hardened legacy extension (fixes F1–F5).** Includes the D2 auth on `multiPublish`, the D1 EAS immutable, removal of `setEas`, and the internal helpers.
4. **Port `SeedProtocolExtensionV2` onto the base.**
5. **Cross-reference hardening (F9).** `require(idx > i)` (or a string-match equivalent for legacy) with a clear error, plus `require(data.length > 0)` before writing `data[0]`. *Behavior change:* forward references only. That's already the only meaningful case.
6. **Extension test suite against the harness:**
   - stranger reverts;
   - admin EOA works;
   - EntryPoint with an admin UserOp works;
   - a session key with `approvedTargets=[account]` works through `handleOps`;
   - a session key with targets that exclude the account is rejected;
   - attestations' `attester == account`;
   - `setEas` selector is gone;
   - `getEas` returns the constructor value;
   - `msg.value` is forwarded once.

   Port the gas tests to go through the account so the numbers include router overhead.
7. **Executor fixes (F6, F8):**
   - value accounting;
   - `revoke`/`multiRevoke`;
   - tests that the account balance changes by exactly `msg.value` and the executor balance stays 0;
   - revocation round-trip.

   Update `MockERC7579Account` to forward value.
8. **`SeedExecutorRouterExtension` (F7)**, with tests:
   - only the installed module can call `executeFromExecutor`;
   - wrong target, disallowed selector, batch mode and value mismatch each revert;
   - install/uninstall work for admin and EntryPoint only;
   - a session key self-call can't install;
   - the end-to-end flow (session key → account.execute(executor) → executor → account → EAS) works with `attester == account`.
9. **Deployment tooling:**
   - replace the `deployProxy`/`upgradeProxy` scripts with plain deploys;
   - `scripts/build_extension_payload.ts` builds the `Extension` struct (metadata + selectors) from artifacts;
   - `scripts/replace_extension_op_sepolia.ts` calls `replaceExtension`/`addExtension` on the factory with the `EXTENSION_ROLE` key, then reads the registry back to verify;
   - `scripts/verify_live_access_control.ts` runs post-deploy checks: a `staticcall` of `multiPublish` from a random address reverts, `setEas` isn't routed, and `getEas` is correct.
10. **Docs:** update the README with the security model, the caller policy and session-key setup (`approvedTargets` must include the account itself, or the executor). Remove the OZ-proxy instructions.

## 4. OP Sepolia rollout
1. Deploy the hardened extension(s) with EAS `0x4200000000000000000000000000000000000021`, and verify on Etherscan.
2. Factory admin calls `replaceExtension` for `SeedProtocolExtension` with the selectors `multiPublish` and `getEas` (`setEas` is dropped). `replaceExtension` deletes all of the old extension's selectors before adding the new list.
3. Run `verify_live_access_control.ts` against a test account.
4. Deploy the fixed `SeedProtocolExecutor` and `SeedExecutorRouterExtension`, then `addExtension` the router extension.
5. Client/SDK changes:
   - stop calling `setEas`;
   - make sure session keys include the account address in `approvedTargets`, or the executor if you move to that path.

Old `eas` values left in account storage are harmless leftovers.

## 5. Inputs needed before rollout
- ManagedAccountFactory address on OP Sepolia, and which key holds `EXTENSION_ROLE`.
- Which `multiPublish` variant the client calls today (legacy string `publishLocalId` or V2 `publishIndex`). Both selectors can be routed at once, but `getEas` can only belong to one extension.
- How the client invokes `multiPublish` today: admin EOA direct, UserOp `execute(account, …)`, or session keys. This confirms D2 covers every live path.
