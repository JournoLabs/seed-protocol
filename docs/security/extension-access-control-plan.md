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
| F8 | — | `SeedProtocolExecutor` | No revocation support (`revoke`/`multiRevoke`). **Declined:** see D8. |
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
`SeedExecutorRouterExtension` is added to the ManagedAccountFactory. **Both the executor and EAS are constructor immutables**, so the factory admin decides which module is trusted. Account admins only opt in or out, and can't be talked into installing a look-alike executor. (This replaces the original `installSeedExecutor(address module)` design.) It exposes:

| Function | Who may call | Behavior |
|----------|--------------|----------|
| `installSeedExecutor()` | admin or EntryPoint only (**not** self, per D1) | marks installed in namespaced account storage, *then* calls `executor.onInstall(abi.encode(EAS))` |
| `uninstallSeedExecutor()` | admin or EntryPoint only | marks uninstalled, *then* calls `executor.onUninstall("")` |
| `isModuleInstalled(uint256, address, bytes)` | anyone (view) | true only for (executor type, the pinned executor, installed) |
| `getSeedExecutor()` | anyone (view) | returns the pinned executor and EAS |
| `executeFromExecutor(ModeCode, bytes)` | installed executor only | see constraints below |

Constraints on `executeFromExecutor`:
- **single call type** and default exec type only;
- **target == EAS** (immutable);
- **selector allowlist**: `attest`, `multiAttest` only (no revocation, per D8);
- **value == msg.value**, so the account never spends its own balance on the executor's behalf.

The trust model matches D2: a session key that can reach the executor can attest as the account, and nothing else.

### D6: Executor fixes
- **`msg.value`**: received exactly once. It's forwarded via `executeFromExecutor{value: …}` on the first EAS call that needs it, and 0 on the rest. Internal `_createSeed`/`_createVersion` take an explicit value. The module never holds ETH: it asserts its balance is unchanged at the end, and has no `receive`.

### D7: Delegated publishing (session keys) is a hard requirement
Users must be able to let a third party publish as their account, and revoke that at any time. This is thirdweb's native session-key mechanism, and the fix keeps it:

- **Grant:** the admin signs a `SignerPermissionRequest` for the delegate with `approvedTargets = [account]`, a time window, and a native-token limit. Once the executor path ships, `approvedTargets = [executor]` also works.
- **Publish:** the delegate signs a UserOp calling `execute(account, 0, multiPublish(...))`. Under the D2 policy this is the allowed `address(this)` caller.
- **Revoke:** the admin signs a new request with no targets, or lets the window expire. The EntryPoint rejects the delegate's UserOps with `AA24`.

`test/ManagedAccountHarness.test.js` pins all of this down against the real account stack, and it must stay green through every step.

Known scoping limits of an account-targeted session key:
- It can call anything that trusts self-calls. Today that's `multiPublish`, `setEas` (removed by D1) and thirdweb's `setContractURI` (metadata only). Any future routed function must not trust `address(this)` for admin-level actions.
- It can attest **any schema with any data** as the account. Revoking the key stops future publishes only, so:
  - **Decided (a):** every attestation created through `multiPublish` (seed, version and properties) is forced revocable, so the owner can always revoke what a delegate published. The `seedIsRevocable` and per-attestation `revocable` request fields are ignored. This assumes every Seed/property schema is registered as revocable; EAS rejects revocable attestations on irrevocable schemas.
  - Both (a) and the future (b) bind delegates only. An admin can always bypass `multiPublish` with `execute(EAS, …)`. A delegate can't, *provided its `approvedTargets` never include EAS or the `address(0)` wildcard*. The client's grant flow must enforce that.

Executor-path notes for step 8 (as implemented in step 7):
- `onInstall`/`onUninstall` only take effect when the account's `isModuleInstalled(2, executor, "")` already reports the module installed (install) or no longer installed (uninstall). This stops a session key that targets the executor from wiping or re-pointing its config. The Router extension must therefore expose `isModuleInstalled`, mark the module installed *before* calling `onInstall`, and mark it uninstalled *before* calling `onUninstall`.

### D8: Delegates cannot revoke
No delegate-reachable path may revoke attestations. The executor has no `revoke`/`multiRevoke`, and the step 8 Router extension won't let executors call EAS's revocation functions.

Why not "delegates may revoke only what they published": nothing on-chain records *which signer* published an attestation.
- EAS records the account as the attester.
- Under a session key, the extension and the executor both see only `msg.sender == account`. thirdweb's `validateUserOp` checks the signer but doesn't pass it on to the execution phase.
- An identity supplied in calldata is just a claim, so a delegate could pass the owner's.

So any revoke function a delegate can reach could revoke **all** of the account's revocable attestations, owner's included. Owners already revoke directly with `execute(EAS, 0, revoke(...))` (tested in the access suite). An automation-friendly design is under future work.

## 3. Work breakdown (one commit each)

> **Deployment moved:** step 9 (deployment tooling), the remainder of step 10 (docs), §4 (OP Sepolia rollout), §4b (client changes) and §5 (inputs) are carried forward and tracked in [docs/deploy-plan.md](../deploy-plan.md). The sections below are kept as the original record.
>
> **Status (2026-10-02):** steps 9 and 10 are done there (deploy plan steps 1–8 and 10; the security model and session-key setup are in the README). §4 waits on deploy plan step 9.

1. **Test harness for real thirdweb accounts.** Add `contracts/test/ThirdwebHarness.sol` importing `EntryPoint`, `ManagedAccountFactory` and `ManagedAccount`. Add `test/fixtures/managedAccountFixture.js`, which:
   - deploys EAS, SchemaRegistry, EntryPoint and the factory;
   - registers extensions;
   - creates an account owned by `admin`;
   - provides helpers to grant session keys and to send UserOps through `EntryPoint.handleOps`.

   Existing tests call the extension directly, which can't catch F1–F4.
2. **Regression tests for F1/F2 (expected to fail).** A stranger calling `account.multiPublish` and `account.setEas` succeeds today. Commit these as `it.skip`/pending, then flip them on in step 3.
3. **`SeedProtocolExtensionBase` + hardened legacy extension (fixes F1–F5).** Includes the D2 auth on `multiPublish`, the D1 EAS immutable, removal of `setEas`, and the internal helpers.
4. **Port `SeedProtocolExtensionV2` onto the base.**
5. **Cross-reference hardening (F9).** Revert with a clear error when `propertiesToUpdate` targets an already-attested request (`idx < i`; `idx == i` is a valid self-reference because cross-references are applied before the current request is attested), and require `data.length > 0` before writing `data[0]`. Legacy gets the same checks on its string match. Also revert with `PropertyToUpdateNotFound` when a reference matches no attestation in the target request (done after step 7; was a silent no-op).
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
7. **Executor fixes (F6), done:**
   - value accounting: the account balance changes by exactly `msg.value` and the executor balance stays 0; unused value reverts;
   - `onInstall`/`onUninstall` guards against session-key griefing;
   - parity with the extensions via `SeedPublishLib` (forced revocability, cross-reference rules);
   - no `revoke`/`multiRevoke` (D8).

   `MockERC7579Account` already forwarded value correctly, so it needed no change.
8. **`SeedExecutorRouterExtension` (F7), done** (`test/SeedExecutorRouterExtension.test.js`; the guards were mutation-checked), with tests:
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

## 4b. Client (seed-protocol-sdk) changes required before rollout
Reviewed `../seed-protocol-sdk` at `73cc8c8` (2026-10-02). The contract fixes break these SDK paths, so the SDK changes must ship before (or with) the extension replacement:

1. **Interactive "modular" publishing calls the ManagedAccount directly from a non-admin session key.**
   - `ensureManagedSignerSessionKey` adds the modular (EIP-7702) wallet with `addSessionKey` (not admin).
   - `createAttestations` then sends `multiPublish` with `to = managedAddress` from that wallet, so the account sees `msg.sender = modular wallet`.
   - This works today only because `multiPublish` was unauthenticated. After the fix it reverts `Unauthorized`.
   - Fix options: (a) send ManagedAccount UserOps signed by the modular wallet's key (`execute(account | executor, …)`), the standard session-key flow the harness tests; or (b) make the modular wallet an account admin (simpler, but full control).
2. **`ensureManagedAccountEasConfigured` sends `setEas`**, which is no longer routed (D1). It should only check `getEas()` against config (`assertManagedAccountEasMatchesConfig` already does).
3. **`defaultApprovedTargetsForModularPublish` grants `[account, EAS, executor]`.** EAS as a target lets that key attest directly, bypassing forced revocability (D7), and the account target lets it call any self-callable function. If (1a) is chosen, grant only what the flow uses (ideally just the executor). Automation keys already use executor-only targets (`approvedTargetsForAutomationPublish`).
4. **Revocation via the executor** (`revokeAttestations` sends `multiRevoke` to the executor for automation keys and "legacy module attester" seeds) no longer exists (D8). Revocation must be owner-signed via `execute(EAS, multiRevoke)`.
5. **`assertExecutorModuleReadyForAccount`** treats Router accounts as unsupported for automation. With `SeedExecutorRouterExtension` installed (`installSeedExecutor`, admin-signed), they're supported; `isInitialized`/`getEAS` checks still work.

Verified compatible, no change needed:
- **Request ordering:** `orderPayloadByDependencies` topologically sorts so referenced seeds come first, matching the forward-reference rule.
- **List relations:** encoded as one `bytes32[]` attestation, always resolved client-side. Batches with unresolved ids publish one request per tx (`hasCrossPayloadUnresolved`), with cross-request `propertiesToUpdate` filtered out, so the contract never fills lists.
- **Single relations:** one attestation and one data entry per target (deduped), with a placeholder the contract replaces. Compatible with `PropertyToUpdateNotFound` / `AmbiguousPropertyToUpdate`.
- **Executor ABI:** `publishIndex`, `versionUid` before `seedSchemaUid`; matches. The SDK doesn't call `createSeed`/`createVersion`/`publish` on the executor.

## 5. Inputs needed before rollout
- ManagedAccountFactory address on OP Sepolia, and which key holds `EXTENSION_ROLE`.
- ~~Which `multiPublish` variant the client calls.~~ **Answered (SDK):** the legacy string `publishLocalId` ABI on the ManagedAccount (`packages/publish/src/helpers/abi/publisher.ts`), and the executor's `publishIndex` ABI on the executor.
- ~~How the client invokes `multiPublish`.~~ **Answered (SDK):** see section 4b. One live path is **not** covered by D2 and depends on the vulnerability.
- ~~How the client orders requests in a batch.~~ **Answered:** the client publishes referenced seeds first, then the requests whose properties reference them. That's what the contracts require (backward references revert with `PublishTargetAlreadyAttested`). The 2024 sample in `scripts/utils/test_data.ts` uses the backward order and gets fixed with the scripts in step 9.

## 6. Future work (not in this branch)
- **(b) Per-account schema allowlist for `multiPublish`.** The admin manages a set of schema UIDs that `multiPublish` may attest; an empty set means "allow all" so existing accounts keep working. Limits what a delegate can publish, not just whether the owner can undo it. Notes:
  - It's per account, not per delegate: the extension can't tell which session key signed a self-call.
  - Its setters must be admin/EntryPoint-only (not self), like `installSeedExecutor`, so SDK admins need a direct call or a raw UserOp.
  - Costs ~2.1k gas per distinct schema per publish (cold SLOAD).
  - Upkeep grows with how often apps introduce new property schemas.
- **Per-delegate scoping.** Separate permissions per third party (schemas, expiry) need a different model: the delegate calls the extension from its own address, and the extension checks an owner-managed delegate registry. Worth it only if per-delegate limits become a product requirement.
- **Delegate revocation for automation (D8).** "A delegate may revoke only what it published" needs the contracts to know which delegate is acting. That means the per-delegate model above: the delegate calls the account from its own address, the extension checks an owner-managed registry, and it records the publishing delegate per attestation UID. Revoke is then allowed only on that delegate's records. Cost: roughly 20k gas per recorded attestation, plus a different delegation flow (no session-key UserOps). Revisit if users ask for automated revocation.
