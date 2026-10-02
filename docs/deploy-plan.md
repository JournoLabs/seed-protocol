# Deploy plan: Hardhat 3 tooling and the OP Sepolia rollout

Branch: `chore/deploy-plan` (from `main` @ `1e71213`)
Scope: replace the Hardhat 2 deploy scripts with Hardhat 3 tooling, then roll the access-control fixes out to **OP Sepolia** (test users only, as in the access-control plan). Mainnet is out of scope.

This plan combines and supersedes:
- the deploy follow-ups in [hardhat3-migration-plan.md §6](hardhat3-migration-plan.md#6-follow-ups-not-in-this-branch);
- the deploy parts of [security/extension-access-control-plan.md](security/extension-access-control-plan.md): step 9 (deployment tooling), the rest of step 10 (docs), §4 (OP Sepolia rollout), §4b (client changes) and §5 (inputs).

The design decisions there (D1–D8) still apply; this plan only covers getting the contracts deployed and used.

## 1. Starting point

**Contracts, ready on `main`:** the hardened `SeedProtocolExtension` and `SeedProtocolExtensionV2`, the fixed `SeedProtocolExecutor`, and the new `SeedExecutorRouterExtension`. All 116 tests pass on Hardhat 3, and CI runs build, type-check and tests.

**Live on OP Sepolia today** (checked with `cast codesize` against `https://sepolia.optimism.io`):

| Address | What | Source |
|---------|------|--------|
| `0x4200…0021` / `0x4200…0020` | EAS / SchemaRegistry (OP predeploys) | — |
| `0xA2b8…0E57`, `0x0F47…b666`, `0x9508…b596`, `0xf331…da8` | Old OZ Transparent proxies (SeedProtocol / SeedProtocolExtension). `0xf331…` is the one `upgrade_optimism_sepolia.ts` targeted. | `.openzeppelin/op-sepolia.json` |
| `0xe8A5…607A` | A later extension implementation listed in `get_extension_json.ts` | `scripts/get_extension_json.ts` |
| `0x0434…5F3E` | Old `SeedProtocolExecutor`, before the F6 fixes | `deployments/executor-and-mock.json` |
| `0xba5E…a5Ed` | CreateX factory, used by Ignition's `create2` strategy | — |

Which of these the factory currently routes `multiPublish`/`setEas`/`getEas` to is **not recorded in the repo**. It's read from the factory in step 7.

**Unknown (inputs, §5):**
- the `ManagedAccountFactory` address on OP Sepolia;
- which key holds `EXTENSION_ROLE`;
- whether any account installed the old executor.

**Tooling:** 18 Hardhat 2 scripts are still in `scripts/` (marked "not yet ported"). `tsconfig.test.json` keeps them out of the CI type-check. Hardhat Ignition 3 and `hardhat-verify` 3 are already installed through the toolbox, and `hardhat.config.ts` has `optimism_sepolia` plus `verify.etherscan`, both using `configVariable`.

## 2. Decisions

### P1: Deploy with Hardhat Ignition
- Ignition modules replace `deploy_*.ts`, `setup_local.ts` and the hand-written `deployments/*.json` manifests.
- Ignition records every deployment in `ignition/deployments/<id>/` (addresses, journal, build info). That record is committed and is the one place deployed addresses live.
- It resumes interrupted deploys instead of redeploying.
- `ignition deploy --verify` verifies on Etherscan through `hardhat-verify` v3, which uses the Etherscan V2 API.

Plain scripts are still used where Ignition doesn't fit: one-off admin calls whose signer may not be the deployer (P4), and read-only checks (P5).

### P2: CREATE2 via CreateX, with a sender-guarded salt
- Use `--strategy create2`. Ignition calls CreateX `deployCreate2(salt, initcode)`.
- **Salt layout:** the first 20 bytes are the deployer address, then `0x00`, then 11 bytes of label. CreateX only lets that deployer use a salt whose first 20 bytes are its own address, so nobody else can deploy to "our" addresses. Byte 21 = `0x00` allows the same address on other chains.
- **Verify CreateX's guard semantics against its docs before the first real deploy** (step 1 includes a local test of this).
- Addresses depend on constructor args. `SeedProtocolExtension`, `SeedProtocolExtensionV2` and `SeedExecutorRouterExtension` take the EAS address, which is the same `0x4200…0021` on every OP Stack chain. So they match across OP Stack chains but not on Ethereum L1. The executor has no constructor args, so its address is the same everywhere.
- The salt goes in `hardhat.config.ts` under `ignition.strategyConfig.create2.salt`.

### P3: Keep solc 0.8.27 / `paris` for this rollout
That's the bytecode the 116 tests and the mutation check cover.
- Upgrading solc and the EVM target changes every deployed address (P2), so do it once, before any mainnet deploy.
- That item stays in the migration plan's §6.

### P4: Router changes are a script that falls back to printing calldata
`scripts/replace_extension.ts` works on any network and handles both cases for the `EXTENSION_ROLE` holder:
- **A local key or impersonated account:** the script sends `replaceExtension`/`addExtension`.
- **A wallet the script can't use** (thirdweb dashboard, Safe, hardware wallet): it prints the target, the calldata and a readable summary to submit by hand.

Either way, it first records the factory's current routing for rollback, and finishes by reading the registry back. Which case applies depends on input I2.

### P5: One post-deploy check script, used everywhere
`scripts/verify_live_access_control.ts` only makes static calls, so it's safe on any network. It runs:
- the access-control plan's step 9 checks:
  - a `staticcall` of `multiPublish` from a random address reverts with `Unauthorized`;
  - `setEas` isn't routed;
  - `getEas()` is `0x4200…0021`;
- the executor routing checks:
  - `getSeedExecutor()` returns the new executor and EAS;
  - every selector routes to the expected implementation.

It exits non-zero on any mismatch.

### P6: Rehearse twice before touching OP Sepolia
1. **Local rehearsal.** A `LocalStack` Ignition module deploys EAS, schemas, EntryPoint, a `ManagedAccountFactory` and one account to a `hardhat node`. Then the same rollout steps run against it.
   - This replaces `setup_local.ts`, `validate_multi_publish_local.ts` and the old `USE_LOCALHOST` tests (migration plan H7).
2. **Fork rehearsal.** An `optimism_sepolia_fork` network (`edr-simulated`, forking OP Sepolia) runs the real rollout against the **real** factory and an existing test account, impersonating the `EXTENSION_ROLE` holder.
   - This catches surprises in the live router state (old selectors, an unexpected registry) before any real transaction is sent.

### P7: Register the legacy extension now; V2 waits for the SDK
The SDK calls the legacy `publishLocalId` ABI on the account (access-control plan §5), so the factory gets the hardened `SeedProtocolExtension` with `[multiPublish, getEas]`.
- `SeedProtocolExtensionV2` is deployed and verified, but not routed until the SDK switches to `publishIndex`.

### P8: No mocks on public networks
`deploy_executor_and_mock.ts` put `MockERC7579Account` on OP Sepolia. The rehearsals use the real thirdweb stack instead, so mocks stay in tests.

### P9: Old deploy records are deleted only after the rollout
`.openzeppelin/op-sepolia.json` and `deployments/*.json` hold the old addresses, which are the rollback targets. Keep them until §3 step 9 completes, then delete them in the same commit that records the new addresses here.

## 3. Work breakdown (one commit each)

1. **Ignition setup.**
   - Add `ignition/modules/SeedProtocol.ts`, which deploys:
     - `SeedProtocolExtension(eas)`
     - `SeedProtocolExtensionV2(eas)`
     - `SeedProtocolExecutor()`
     - `SeedExecutorRouterExtension(eas, executor)`
   - `eas` is a module parameter. Parameter files: `ignition/parameters/optimism_sepolia.json` (`0x4200…0021`) and `localhost.json`.
   - Add the CREATE2 salt config (P2).
   - Add a test that deploys the module in-process with `--strategy create2` twice, from two different senders. It checks that the addresses are deterministic, and that the guarded salt rejects the second sender (or yields a different address).

2. **Shared extension helpers.**
   - Move `buildExtension`, `mergeInterfaces` and the selector lists (`[multiPublish, getEas]`, `EXECUTOR_ROUTER_FUNCTIONS`) from `test/fixtures/managedAccountFixture.ts` into `scripts/lib/extensions.ts`.
   - Tests import them from there, so the selectors the tests register are exactly the ones the rollout registers.

3. **`scripts/build_extension_payload.ts`.** Replaces `get_extension_json.ts`.
   - Builds the `Extension` structs (metadata + selectors) from the Ignition deployment's addresses and the artifacts' ABIs.
   - Prints them as JSON for review or a dashboard.
   - `metadataURI` comes from input I5.

4. **`scripts/replace_extension.ts`** (P4):
   - Reads the factory address from parameters.
   - Snapshots `getImplementationForFunction` for every Seed selector, old and new, to `ignition/deployments/<id>/routing-before.json`.
   - Then `replaceExtension(SeedProtocolExtension)` (its old selectors include `setEas`; `replaceExtension` drops all of them before adding the new list).
   - Then `addExtension(SeedExecutorRouterExtension)`.
   - Reads the registry back and fails if any selector routes to the wrong implementation.
   - Has a `--dry-run` that only prints.

5. **`scripts/verify_live_access_control.ts`** (P5). Add a test that runs it against the in-process `ManagedAccount` fixture, so it can't silently rot.

6. **Local rehearsal** (P6.1):
   - `ignition/modules/LocalStack.ts`
   - an npm script `rehearse:local`: start `hardhat node`, deploy `LocalStack`, deploy `SeedProtocol`, run `replace_extension`, run `verify_live_access_control`, run one admin publish
   - Delete `setup_local.ts`, `validate_multi_publish_local.ts`, `deploy_local*.ts` and `deploy_executor_and_mock.ts`.

7. **Fork rehearsal** (P6.2):
   - Add the `optimism_sepolia_fork` network (`forking.url: configVariable("OPTIMISM_SEPOLIA_RPC_URL")`) and an npm script `rehearse:op-sepolia`.
   - The rehearsal impersonates the `EXTENSION_ROLE` holder, then runs steps 4–5 plus an admin publish and a session-key publish against an existing test account.
   - Record the factory's real current routing (§1 unknown) and the rehearsal result here.

8. **Script cleanup and type-check.** Every remaining script is deleted or ported, per the table below.
   - Delete `tsconfig.test.json` and type-check everything in CI.
   - Fix or delete `scripts/utils/test_data.ts`. Its 2024 sample uses the backward request order the contracts now reject (access-control plan §5).

   | Script | Fate | Why |
   |--------|------|-----|
   | `deploy_local.ts`, `deploy_local_and_save.ts`, `deploy_executor_and_mock.ts`, `setup_local.ts`, `validate_multi_publish_local.ts` | delete | Replaced by Ignition modules + `rehearse:local` (step 6) |
   | `get_extension_json.ts`, `get_signature.ts` | delete | Replaced by `build_extension_payload.ts` (step 3) |
   | `extract_input_json.ts`, `extract_metadata.ts` | delete | Manual-verification helpers (wrote `verify/`); replaced by `ignition deploy --verify` |
   | `test_contract.ts`, `test_local.ts`, `test_optimism_sepolia.ts` | delete | 2023–24 smoke tests against old contracts; replaced by `verify_live_access_control.ts` |
   | `send_eth.ts` | delete | `cast send` does this |
   | `debug_multi_publish.ts` | port | Useful for decoding EAS reverts against a real account |
   | `decode_attestation_data.ts` | port or delete | Small utility. **Your call (I6)** |
   | `get_4_byte_selectors.ts`, `print_test_json.ts` | keep | Already run on bun; `print_test_json` follows `test_data.ts` |
   | `utils/deploy.ts`, `utils/index.ts`, `utils/test_attestations.ts` | delete | Only used by the scripts above; `deploy.ts` is the old `deployProxy` path |

9. **OP Sepolia rollout.** This is an operational step: run it together, recording each result here. **Gate:** I1–I4 answered, step 7 green, and the SDK changes from §4 released or ready to ship at the same time.
   1. `ignition deploy ignition/modules/SeedProtocol.ts --network optimism_sepolia --strategy create2 --parameters ignition/parameters/optimism_sepolia.json --verify`
   2. `replace_extension.ts --network optimism_sepolia --dry-run`. Review the printed changes.
   3. `replace_extension.ts --network optimism_sepolia`, or submit the printed calldata from the `EXTENSION_ROLE` wallet (P4).
   4. `verify_live_access_control.ts --network optimism_sepolia` against a test account.
   5. An admin publish and a session-key publish from the updated SDK against a test account.
   6. Retire the old executor `0x0434…`. It can't be removed from the chain, so: point the SDK config at the new one, and if I4 finds accounts that installed it, have them uninstall it.
   7. Commit `ignition/deployments/`, record the addresses below, and delete `.openzeppelin/` and `deployments/` (P9).

   **Rollback:** `replaceExtension` back to the implementations in `routing-before.json`.
   - Those implementations are vulnerable (F1–F5), so roll back only for a breaking failure, and only for as long as it takes to redeploy a fix.
   - `addExtension` of the router extension is undone with `removeExtension`.

10. **Docs.** Update the README with:
    - the deploy and rehearsal commands;
    - the security model and caller policy (access-control D2);
    - session-key setup: `approvedTargets` must include the account itself for `multiPublish`, or only the executor for the executor path (D5, D7).

    Mark access-control plan steps 9–10 and §4 as done, pointing here.

## 4. Client (seed-protocol-sdk) changes

Copied from [access-control plan §4b](security/extension-access-control-plan.md#4b-client-seed-protocol-sdk-changes-required-before-rollout), reviewed at SDK `73cc8c8`. These must ship before or with step 9.3, or the paths below break:

1. **Interactive "modular" publishing** calls the account directly from a non-admin session key. After the fix this reverts with `Unauthorized`.
   - Fix (a): send UserOps signed by that key (`execute(account | executor, …)`), as the harness tests do.
   - Fix (b): make it an account admin (full control).
2. **`ensureManagedAccountEasConfigured` sends `setEas`**, which is no longer routed. It should only check `getEas()`.
3. **`defaultApprovedTargetsForModularPublish` grants `[account, EAS, executor]`.**
   - EAS as a target bypasses forced revocability (D7).
   - With fix 1(a), grant only what's used (ideally just the executor).
4. **Executor revocation** (`multiRevoke` via the executor) no longer exists (D8). Revoke owner-signed via `execute(EAS, multiRevoke)`.
5. **`assertExecutorModuleReadyForAccount`** treats Router accounts as unsupported. With `SeedExecutorRouterExtension` installed they're supported.

The SDK also needs the new addresses (executor, extensions) from step 9.7.

## 5. Inputs needed

| ID | Input | Needed by |
|----|-------|-----------|
| I1 | `ManagedAccountFactory` address on OP Sepolia | step 4 (parameters), step 7 |
| I2 | Who holds `EXTENSION_ROLE`, and can a script use that key (raw key / keystore) or is it a dashboard/Safe wallet? Decides P4's mode. | step 4, step 9.3 |
| I3 | A test account (and its admin key) on OP Sepolia for the fork rehearsal and post-deploy checks | steps 7, 9.4–9.5 |
| I4 | Did any account install the old executor `0x0434…`? (Old SDK automation keys, or non-thirdweb ERC-7579 accounts) | step 9.6 |
| I5 | `metadataURI` for the extension metadata. The old ones were thirdweb-published IPFS URIs; `""` works on-chain. | step 3 |
| I6 | Keep `decode_attestation_data.ts`? | step 8 |
| I7 | Deployer key for OP Sepolia. Today `DEV_KEY`; consider `hardhat-keystore` (installed) instead of a plaintext `.env` | step 9.1 |

## 6. Risks

- **SDK and contracts must switch together.** Until the §4 changes ship, replacing the extension breaks interactive publishing (4.1) and EAS setup (4.2) for existing users. The step 9 gate exists for this reason; test users only, per scope.
- **Unknown live router state.** The repo doesn't record what the factory routes today (§1). Step 7 reads it on a fork before anything is sent, and `routing-before.json` captures it for rollback.
- **CreateX salt semantics** (P2) are the only line between us and an address squatter. Step 1 tests the guard locally before it's relied on.
- **Fork fidelity.** EDR forks OP Sepolia state but simulates L1 fees differently from the real chain. The rehearsal is for routing and access control, not gas.
- **Rollback re-exposes F1–F5** (step 9). That's acceptable briefly on a test-users-only testnet, never as a resting state.

## 7. Not in this plan

These stay in [hardhat3-migration-plan.md §6](hardhat3-migration-plan.md#6-follow-ups-not-in-this-branch):
- the solc/EVM upgrade (P3);
- Solidity fuzz and invariant tests;
- Slither/Aderyn;
- OZ 5;
- `node:test` + viem.

The access-control plan's §6 future work (per-account schema allowlist, per-delegate scoping, delegate revocation) is unchanged.

## 8. Progress log

*(empty)*
