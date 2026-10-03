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
- Upgrading solc and the EVM target changes every deployed address (P2), so do it once, before any mainnet deploy. That's step 11, after the OP Sepolia rollout.

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
   1. `hardhat seed:predict-addresses --network optimism_sepolia` (all four `free`), then `hardhat ignition deploy ignition/modules/SeedProtocol.ts --network optimism_sepolia --strategy create2 --parameters ignition/parameters/optimism_sepolia.json --verify`
   2. `hardhat seed:replace-extension --network optimism_sepolia --dry-run`. Review the printed changes.
   3. `hardhat seed:replace-extension --network optimism_sepolia`, or submit the printed calldata from the `EXTENSION_ROLE` wallet and then run it with `--check-only` (P4).
   4. `hardhat seed:verify-live --network optimism_sepolia --account <test account>`.
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

11. **Compiler upgrade, before any mainnet deploy** (P3). Not part of the OP Sepolia rollout; do it once, so the mainnet addresses are set once. **Gate:** step 9 done, and no mainnet deploy until this step is green.
    - Bump `solidity.version` in `hardhat.config.ts` to the latest 0.8.x, and pin the `^0.8.0` / `^0.8.20` pragmas in `contracts/` to it.
    - Choose `evmVersion` by what every target chain supports, not by solc's default (OP Stack chains have Cancun opcodes since Ecotone). Record the choice and why in P3.
    - The `npmFilesToBuild` contracts (EAS, EntryPoint, thirdweb) build with these settings too: check `hardhat build` for new warnings beyond thirdweb's known payable-fallback one.
    - Rerun the full test suite, the mutation check and the gas reports. Record the gas deltas here.
    - Re-run `seed:predict-addresses` and replace the predicted addresses in §8. Update anything else that hardcodes them.
    - Repeat the fork rehearsal (step 7) with the new bytecode.
    - If OP Sepolia should match mainnet, redeploy there and repeat step 9's replace-extension and verify-live; otherwise note that testnet keeps the 0.8.27 build.

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

**Released in seed-protocol-sdk 0.6.8 (2026-10-03).**

## 5. Inputs needed

| ID | Input | Needed by |
|----|-------|-----------|
| I1 | `ManagedAccountFactory` address on OP Sepolia. **Answered:** `0x76F47D88bfaf670F5208911181fCDC0E160cb16d`, in `ignition/parameters/optimism_sepolia.json` as `SeedRollout.factory`. | step 7, step 9 |
| I2 | Who holds `EXTENSION_ROLE`, and can a script use that key (raw key / keystore) or is it a dashboard/Safe wallet? Decides P4's mode. **Answered by the factory:** the only holder is `0x00467f…4D84B`, the `DEV_KEY` address, so the script sends the call itself if that key is used (P4's first mode). If the deploy keys change (I7), the role has to be granted to the new key first, or the calldata submitted from `0x00467f…`. | step 9.3 |
| I3 | Test accounts on OP Sepolia for 9.4–9.5. **Answered (2026-10-03):** two permapress logins, both on factory `0x76F4…`. No keys are needed: 9.4 is read-only, and 9.5 is published from permapress logged in as these users. **(a) Pre-rollout account** `0x25B171f3315EBF64F0B878f1d979e9b875b86FFd`, admin `0x8436cdD8b5357258ecb93BF1367440B93A0c47F8` (the in-app EOA, 7702-delegated to thirdweb's `MinimalAccount`). Deployed; no UserOps yet; one session key `0xc6819c9B3aA171DA8A2718d82f5A4714F1968C6F` approved only for the old executor `0x0434…` (valid to 2026-12-30), which was never installed. Tests the upgrade path: 0.6.8 must install the new executor and grant a new executor-only key rather than reuse the old one. Use it for 9.4's `--account`. **(b) New account** `0x803e4b34688467699B5B73D6e80fa9e8EC401aD3`, admin `0x463723fA773738e2a6e916C13F2368D5777EE40C`. Counterfactual: the factory's predicted address for that admin, with no code and the EOA unused. Tests the new-user path; **don't publish from it before 9.3**, so it's first set up against the new contracts. | steps 9.4–9.5 |
| I4 | Did any account install the old executor `0x0434…`? **Answered: no (2026-10-02).** See the progress log. | step 9.6 |
| I5 | `metadataURI` for the extension metadata. **Answered (2026-10-03): `""`** (the default; no `--metadata-uri`). The live extension's URI (`ipfs://QmfNsW…`) is the solc metadata of an old 0.8.20 `SeedProtocolExtension` (with `setEas`, `createSeed`, `publish`, `initialize`), so it would misdescribe the new contract. Nothing on-chain reads the field; `--verify` puts the source and ABI on Etherscan. If a tool turns out to need it, set it later with one `replaceExtension` from the `EXTENSION_ROLE` key. | step 3 |
| I6 | Keep `decode_attestation_data.ts`? **Answered: keep** for now, pending personal review; it stays unported and out of the type-check. | step 8 |
| I7 | Deployer key for OP Sepolia. **Answered (2026-10-03): keep `DEV_KEY`** (`0x00467f…4D84B`). The predicted addresses in §8 and the `EXTENSION_ROLE` holder (I2) stay as they are. | step 9.1, 9.3 |

## 6. Risks

- **SDK and contracts must switch together.** Until the §4 changes ship, replacing the extension breaks interactive publishing (4.1) and EAS setup (4.2) for existing users. The step 9 gate exists for this reason; test users only, per scope.
- **Unknown live router state.** The repo doesn't record what the factory routes today (§1). Step 7 reads it on a fork before anything is sent, and `routing-before.json` captures it for rollback.
- **CreateX salt semantics** (P2) are the only line between us and an address squatter. Step 1 tests the guard locally before it's relied on.
- **Fork fidelity.** EDR forks OP Sepolia state but simulates L1 fees differently from the real chain. The rehearsal is for routing and access control, not gas.
- **Rollback re-exposes F1–F5** (step 9). That's acceptable briefly on a test-users-only testnet, never as a resting state.

## 7. Not in this plan

These stay in [hardhat3-migration-plan.md §6](hardhat3-migration-plan.md#6-follow-ups-not-in-this-branch):
- Solidity fuzz and invariant tests;
- Slither/Aderyn;
- OZ 5;
- `node:test` + viem.

The access-control plan's §6 future work (per-account schema allowlist, per-delegate scoping, delegate revocation) is unchanged.

## 8. Progress log

**2026-10-02: steps 1–6, 8 and 10 done; step 7 tooling done (run below).** 126 tests pass (116 before this work) and the whole project type-checks; `rehearse:local` is green.

What changed from the plan as written:
- **Rollout scripts are Hardhat tasks** (`seed:*`; see the README's task table), because `hardhat run` can't take flags like `--dry-run`. The files keep their planned names in `scripts/`, and each task's body is an exported function the tests call on the in-process network.
- **The in-process and `localhost` networks moved from chain 1337 to 31337.** Ignition only bootstraps CreateX on 31337. `localhost` no longer pins a chain id, so it serves both rehearsals, and it uses the node's unlocked accounts (so `LOCALHOST_TESTING_KEY` is gone).
- **`seed:replace-extension` sends one `multicall`** (the factory has `Multicall`), so the replace and the add land together, and a hand-submitted call is a single transaction. It replaces the Seed extension under whatever name it's registered as (`replaceExtension` keys on the name) and refuses if more than one registered extension looks like a predecessor, or if any new selector is routed to an unrelated extension. `routing-before.json` holds the factory's whole registry and its `EXTENSION_ROLE` holders, and is never overwritten.
- **Both rehearsals run on a `hardhat node`,** not an in-process fork: every task is its own process, and an in-process fork would forget state between them. `rehearse:op-sepolia` starts the node on `optimism_sepolia_fork`.
- **The fork rehearsal can't deploy from the real deployer:** Ignition refuses an impersonated `--default-sender`. It deploys from a node account instead (different CREATE2 addresses, same routing and access control), and the new **`seed:predict-addresses`** covers the real addresses. That task `eth_call`s CreateX's `deployCreate2` from the deployer, with the executor's code as a state override for the router extension. It's read-only, so it also runs against live OP Sepolia.
- **New `seed:publish-smoke`** does the "admin publish" and "session-key publish" steps. `createAccount` is permissionless, so on the fork it creates a fresh account on the real factory with a local admin key. That's why I3 no longer needs the test account's admin key.
- **P2 verified against CreateX's source** (`_guard`/`_parseSalt`): the salt `deployer ‖ 0x00 ‖ "seed-v1"` yields `keccak256(deployer ‖ salt)` for the deployer; any other sender lands in the "random" branch, `keccak256(abi.encode(salt))`. `test/ignition.SeedProtocol.test.ts` checks both against a real CreateX.
- **Step 8:** `debug_multi_publish.ts` is ported as `seed:debug-publish`, which simulates through the *account* rather than the extension. `utils/test_data.ts` is deleted rather than fixed, and so is `print_test_json.ts`, which only printed it. The maintained samples are `test/fixtures/multi_publish_*.json`. `decode_attestation_data.ts` is the only file left out of the type-check, pending I6.
- **Account helpers** (session keys, UserOps, publish requests) moved from the test fixture to `scripts/lib/managedAccount.ts` so the rehearsal can use them; the fixture re-exports them.

**Predicted OP Sepolia addresses** (`seed:predict-addresses --network optimism_sepolia`, deployer `0x00467f…4D84B`, salt label `seed-v1`, solc 0.8.27/paris). All four are `free`, and CreateX would deploy exactly there:

| Contract | Address |
|----------|---------|
| `SeedProtocolExtension` | `0x2ee2571cF7C68998292A6E1715Dc4F799A4D5CB4` |
| `SeedProtocolExtensionV2` | `0xF24554E658F167d5DE937066be4824C731183880` |
| `SeedProtocolExecutor` | `0x7AaC33b02a63035452fA5eee07F45351c0684B62` |
| `SeedExecutorRouterExtension` | `0x8eAe1425c19394b1199eA553f50547A6bA8FEf08` |

These change if the deployer (I7), the salt label, the compiler settings (P3) or the contracts change.

**I4: nobody installed the old executor.** `0x043462304114da543add6B693c686B7d98865F3E` was created at block 39,946,574 by `0x00467f…4D84B` (DEV_KEY). Etherscan V2 shows no other transaction to it, no internal calls into it (an account's `onInstall` would be one), and no logs at all, including its `ModuleInitialized`. Caveat: the full-range log query couldn't be cross-checked against a known-busy contract (EAS timed out), so the transaction lists are the main evidence. Step 9.6 is then just pointing the SDK at the new executor.

**2026-10-02: step 7 done.** `bun run rehearse:op-sepolia` passes against the real factory, forked at block 49,587,876:
- **Live routing before the rollout** (also in `ignition/deployments/op-sepolia-fork-rehearsal/routing-before.json`, gitignored):
  - `AccountExtension` → `0xCD68591e4F9FA55c4a9938A5574E22517047a055` (20 functions);
  - `SeedProtocolExtension` → `0xe8A567d96BaaF98805A186bb825cC0b2430b607A`, the last implementation in the old `get_extension_json.ts`. It routes `multiPublish`, `setEas` and `getEas`, with metadata `ipfs://QmfNsWGDnnKVw5bYuWnvy9j13bhv4vH3XeaJH6SuDLPjyw`.

  Nothing else is registered, so there are no selector conflicts.
- **`EXTENSION_ROLE`:** held only by `0x00467f…4D84B` (`DEV_KEY`).
- **Result:** one `multicall` replaced `SeedProtocolExtension` (dropping `setEas`) and added `SeedExecutorRouterExtension`, and the routing read-back passed. `verify-live` passed all 12 checks on the factory's first account, `0x67a4881391aD8B1f197C6bF7a556d70f87C3a786`. Admin and session-key (UserOp) publishes passed on a fresh account created on the real factory.
- **Fixed on the way:** `verify-live`'s random-caller `eth_call` failed on the forking node, which charges the OP L1 data fee up front even on calls. It now gives the caller a balance with a state override.
- **For I5:** the live extension's `metadataURI` is the IPFS URI above, and the rollout writes `""` unless `--metadata-uri` is passed.

**2026-10-03: pre-deploy checks, and a build-profile fix.** The OP Sepolia RPC (chain 11155420), the Etherscan V2 API key and `DEV_KEY` (→ `0x00467f…4D84B`, 0.13 ETH) all check out. `seed:predict-addresses` then showed four *different* addresses, because Hardhat 3 derived the `production` profile, which `ignition deploy` builds on live networks, from the short-form `solidity` config:
- it kept only the optimizer settings, so `evmVersion` fell back to solc's default `cancun`, contrary to P3;
- it compiled with `isolated: true`, which changes each contract's metadata hash, and so its CREATE2 address, even when the code is the same.

Step 9.1 would have deployed bytecode the tests never ran, at addresses other than the ones above. `hardhat.config.ts` now defines both profiles, identically (`paris`, not isolated). `test/buildProfiles.test.ts` fails if they diverge again. With either profile, `seed:predict-addresses` gives exactly the table above, all `free`; 136 tests pass.

**2026-10-03: fork rehearsal rerun, after the build-profile fix.** `bun run rehearse:op-sepolia --account 0x25B1…6FFd --admin 0x8436…47F8` (I3a) passes, forked at block 49,629,181. The live router is unchanged since step 7: `AccountExtension` → `0xCD68…a055` (20 functions), `SeedProtocolExtension` → `0xe8A5…607A` (`multiPublish`, `setEas`, `getEas`), and `EXTENSION_ROLE` is still held only by `0x00467f…4D84B`. One `multicall` replaced the extension and added the router extension (28 selectors check out), the base schemas are registered, and `verify-live` passed all 13 checks on I3a. Admin and session-key (UserOp) publishes passed on a fresh account, and so did an admin publish on I3a by its real admin, impersonated.
