# Foundry migration plan

Branch: `chore/migrate-to-foundry` (from `fix/extension-access-control` @ `b49f981`)
Scope: move **build and tests** from Hardhat to Foundry. Contract behaviour is out of scope: no Solidity changes under `contracts/` apart from moving test-only files. Deployment and the other `scripts/` are next; this branch only has to leave them working.

## 1. Starting point

| Area | Today |
|------|-------|
| Build | Hardhat 2.28. Three compilers are configured (0.8.19, 0.8.20, 0.8.27), but EAS 1.8 pins `0.8.27`, so in practice everything builds with it. `lib/sstore2/` is remapped through a `TASK_COMPILE_GET_REMAPPINGS` override. |
| Tests | 6 Mocha/Chai suites, 93 `it` blocks in JS (`npm test` runs 5 of them; the gas suite runs separately), plus `test/SeedProtocol.ts`, a stale POC suite with 5 tests that isn't run. |
| Fixtures | `easFixture.js`, `executorEASFixture.js`, `extensionEASFixture.js`, `managedAccountFixture.js` (425 lines: thirdweb EntryPoint v0.6, factory, Router extension registration, EIP-712 session keys, UserOps via `handleOps`), plus `gas_payloads.ts` and the `multi_publish_*.json` payloads. |
| Gas | `hardhat-gas-reporter` plus the custom scripts `gas_benchmark.ts` and `compare_gas_reports.ts`. |
| Solidity deps | npm, locked by `bun.lock`: OZ 4.9.5 (+ upgradeable), `@thirdweb-dev/contracts` 3.15, `@thirdweb-dev/dynamic-contracts`, EAS contracts 1.8.0. |
| Local Foundry | `forge 0.2.0` from Dec 2023. **It can't compile this repo:** it doesn't know solc 0.8.27 and fails with "Unknown version provided". |
| CI | None. |

### Spike result (scratchpad, not committed)
With a current forge (1.6 nightly) and the `foundry.toml` sketched in §3 step 1:
- `forge build` compiles `contracts/` plus thirdweb, EAS and OZ from `node_modules` in about 7 s.
- 101 artifacts, all built with solc 0.8.27.
- The `lib/sstore2/` remapping works.
- Every contract is under the 24 KB limit (`ManagedAccountFactory` is the largest at 19.2 KB runtime), so Hardhat's `allowUnlimitedContractSize` has no Foundry equivalent we need.

## 2. Decisions

### M1: Solidity deps stay on npm, resolved by remappings
Foundry reads OZ, thirdweb and EAS from `node_modules` via `remappings`. `bun.lock` stays the single source of versions, and Foundry compiles exactly the sources Hardhat compiles today. That lets us check bytecode parity (M3).

Only `forge-std` is new. Add it as a git submodule under `lib/` (`forge install foundry-rs/forge-std`); its npm package isn't official.

Moving to Soldeer or upgrading OZ is a separate decision and doesn't belong in this branch.

### M2: Keep the current directory layout
`src = "contracts"`, `test = "test"`. During the migration, Solidity tests (`*.t.sol`) sit next to the JS tests in `test/`, so each suite can be ported and compared while both stacks run.

Test-only Solidity moves out of `contracts/`:
- `contracts/test/ThirdwebHarness.sol` → `test/utils/`
- `contracts/mocks/MockERC7579Account.sol` → `test/mocks/`

**Exception:** `scripts/deploy_executor_and_mock.ts` deploys the mock to OP Sepolia. Leave it where it is until the deploy migration, or update that script's import path. Decide in step 6.

### M3: Same compiler, explicit EVM version, bytecode parity
- Pin `solc_version = "0.8.27"`, `optimizer_runs = 200`, and an explicit `evm_version` that matches what Hardhat uses today.
- Gate: deployed bytecode with the metadata hash stripped must be identical between `artifacts/` and `out/` for:
  - `SeedProtocolExecutor`
  - `SeedProtocolExtension`
  - `SeedProtocolExtensionV2`
  - `SeedExecutorRouterExtension`
- Upgrading solc (latest is 0.8.37) is a later change, done with the deploy work.

### M4: Port tests as Solidity, one suite per commit, with a parity checklist
Every JS `it` gets a Solidity test, or is explicitly marked as dropped, in a mapping table checked into this doc (§4). A JS suite is deleted in the same commit that lands its port, and only once the forge suite is green.

The router guards were mutation-checked in the JS suite. Re-apply the same mutations against the forge suite before deleting `SeedExecutorRouterExtension.test.js`.

### M5: Hardhat stays, for scripts only
After this branch:
- `forge build` / `forge test` are the way to build and test.
- `hardhat` and `@nomicfoundation/hardhat-ethers` remain so that the 18 scripts that `import 'hardhat'` (and the 9 that read `artifacts/` or `eas/*.json`) keep working until the deploy migration.
- Test-only Hardhat deps are removed: chai, chai-matchers, network-helpers, gas reporter, solidity-coverage, `@types/mocha`.

### M6: Drop the `USE_LOCALHOST` hybrid mode
`SeedProtocolExecutor.test.js` can also run against a node deployed by `setup:local`. That's really an integration check of deployment, so it belongs with the deploy work (a `forge script` against anvil). The forge port covers only the in-process path.

### M7: Gas tracking moves to `forge snapshot`
- Commit `.gas-snapshot` and use `forge snapshot --check` in CI.
- Named measurements use `vm.startSnapshotGas`/`vm.stopSnapshotGas` (written to `snapshots/`).
- `gas_benchmark.ts`, `compare_gas_reports.ts`, `gas:*` scripts and the hardhat-gas-reporter config go away.
- Forge measures call gas without the 21k intrinsic cost, so the new numbers start a fresh baseline and **can't be compared** with old `gas-reports/`.

### M8: `test/SeedProtocol.ts` is not ported
It targets the original POC contracts, isn't run by `npm test`, and its coverage is a subset of the executor and extension suites. Delete it. *(Default; say if you want it kept.)*

## 3. Work breakdown (one commit each)

0. **Toolchain.**
   - Update local Foundry to the current stable release (`foundryup --install stable`). The global install is the Dec 2023 build.
   - Record the exact version in the README, and pin it in CI in step 8.

1. **Foundry scaffold alongside Hardhat.**
   - `forge install foundry-rs/forge-std` (creates `.gitmodules`).
   - Add `foundry.toml`:
     ```toml
     [profile.default]
     src = "contracts"
     test = "test"
     out = "out"
     libs = ["node_modules", "lib"]
     solc_version = "0.8.27"
     evm_version = "<match hardhat>"   # see M3
     optimizer = true
     optimizer_runs = 200
     remappings = [
       "forge-std/=lib/forge-std/src/",
       "@openzeppelin/=node_modules/@openzeppelin/",
       "@thirdweb-dev/=node_modules/@thirdweb-dev/",
       "@ethereum-attestation-service/=node_modules/@ethereum-attestation-service/",
       "lib/sstore2/=node_modules/@thirdweb-dev/dynamic-contracts/lib/sstore2/",
     ]
     ```
   - Ignore `out/` and `cache_forge/` in `.gitignore`.
   - Gate: `forge build` is clean. Check that the `lib/sstore2/` remapping still wins now that a real `lib/` directory exists.

2. **Bytecode parity check (M3).**
   - Add a small script, `scripts/check_bytecode_parity.ts`, that compares `artifacts/**` with `out/**` (metadata stripped) for the four production contracts.
   - Run it once and record the result here. Keep the script until Hardhat compilation is gone.

3. **Shared Solidity test base: EAS.**
   - Add `test/utils/EASBase.sol`: deploys `SchemaRegistry` + `EAS` straight from `@ethereum-attestation-service/...` and registers the same seven schemas with the same strings as `easFixture.js`, exposing their UIDs.
   - Also add `test/utils/ExecutorBase.sol` (ports `executorEASFixture.js`: executor + `MockERC7579Account` + `installModule`).
   - Drop the `contracts/EAS.sol` / `contracts/SchemaRegistry.sol` / `eas/*.sol` wrappers only if no script needs their Hardhat artifacts (`scripts/utils/deploy.ts` does today, so they probably stay until the deploy migration).

4. **Port `SeedProtocolExecutor.test.js` → `test/SeedProtocolExecutor.t.sol`** (39 tests).
   - Idioms:
     - `loadFixture` → `setUp()`
     - `.to.be.reverted` / `revertedWithCustomError` → `vm.expectRevert(Selector)`
     - `parseLog` of `Attested` → `vm.recordLogs()` + `vm.getRecordedLogs()`
     - `account.execute.staticCall` → a `vm.prank` call that reads the return value
   - The `multi_publish_*.json` payloads are read with `vm.readFile` + `vm.parseJson`, which needs `fs_permissions = [{ access = "read", path = "./test/fixtures" }]`. Alternatively, rebuild them as Solidity builders if the JSON shape doesn't decode cleanly into the nested structs; decide during the port.
   - Remove the `USE_LOCALHOST` branches (M6).

5. **Shared Solidity test base: thirdweb ManagedAccount.** This is the largest single item; it ports `managedAccountFixture.js` to `test/utils/ManagedAccountBase.sol`:
   - `deployManagedAccountStack({ seedExtension, withExecutor })` becomes three `setUp` variants (legacy, V2, executor).
   - `buildExtension` derives selectors with `.selector` and signatures as string literals. The selector list is written out by hand, so add a test that every selector matches its signature, since the Router validates against it.
   - `setSignerPermissions` / `grantSessionKey` / `revokeSessionKey`: hash the `SignerPermissionRequest` per EIP-712 (domain `"Account"`, `"1"`, `block.chainid`, account) and sign with `vm.sign`. Session keys come from `makeAddrAndKey`.
   - `sendUserOp`: build a v0.6 `UserOperation`, `entryPoint.getUserOpHash(op)`, sign the EIP-191 digest (`ECDSA.toEthSignedMessageHash`) with `vm.sign`, then `handleOps`.
   - `expectUserOpRejected` → `vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, reason))`.
   - Time: Foundry starts at `block.timestamp == 1`. `vm.warp` to a realistic timestamp in `setUp` so the session-key validity windows behave as they do under Hardhat.
   - `impersonate` / `setBalance` → `vm.prank` / `vm.deal`.
   - Port `ManagedAccountHarness.test.js` (12 tests) in the same commit. It exercises this base directly and is its acceptance test.

6. **Port the extension suites on that base:**
   - `SeedProtocolExtension.access.test.js` (9)
   - `SeedProtocolExtension.crossref.test.js` (10)
   - `SeedExecutorRouterExtension.test.js` (22); re-run the router-guard mutation check (M4) before deleting the JS file.

   Move `ThirdwebHarness.sol` and the mock (M2) here once nothing in `test/*.js` imports them by artifact name.

7. **Gas (M7).**
   - Port `SeedProtocolExtension.gas.test.js` and `gas_payloads.ts` to `test/SeedProtocolExtension.gas.t.sol`, going through the account as the current suite does.
   - Commit `.gas-snapshot`.
   - Delete `gas_benchmark.ts`, `compare_gas_reports.ts`, `gasReporterOutput.json`, the `gas:*` / `test:gas` npm scripts and the `gasReporter` config.

8. **CI.** Add `.github/workflows/test.yml`:
   - checkout with submodules
   - `oven-sh/setup-bun` + `bun install --frozen-lockfile` (Solidity deps live in `node_modules`)
   - `foundry-rs/foundry-toolchain` pinned to the version from step 0
   - `forge build --sizes`, `forge test -vvv`, `forge snapshot --check`

   Static analysis (Slither/Aderyn) and `forge fmt --check` are left out here so CI starts green. They're listed in §6.

9. **Remove the Hardhat test stack (M5).**
   - Delete `test/*.js`, `test/fixtures/*.js` and `test/SeedProtocol.ts` (M8).
   - Remove the test-only devDeps.
   - Remove `mocha` from `tsconfig.json` types.
   - npm scripts: `test` → `forge test`, add `build`, `snapshot`, `coverage` (`forge coverage`). Remove `test:localhost` (M6).
   - Trim `hardhat.config.ts` to what scripts need: networks, etherscan and the remapping override. Drop `hardhat-ethernal` if no script uses it.
   - Gate: every script in `scripts/` still type-checks and `npx hardhat compile` still works.

10. **Docs.**
    - Rewrite the README's "Local development" section around `forge build/test/snapshot/coverage`.
    - Note that deploy scripts still use Hardhat until the deploy migration.

## 4. Test mapping checklist

Fill in as suites are ported. "Dropped" needs a reason.

| JS suite | `it` count | Forge suite | Ported | Dropped (reason) |
|----------|-----------:|-------------|-------:|------------------|
| `SeedProtocolExecutor.test.js` | 39 | `SeedProtocolExecutor.t.sol` | | localhost-mode branches (M6) |
| `ManagedAccountHarness.test.js` | 12 | `ManagedAccountHarness.t.sol` | | |
| `SeedProtocolExtension.access.test.js` | 9 | `SeedProtocolExtension.access.t.sol` | | |
| `SeedProtocolExtension.crossref.test.js` | 10 | `SeedProtocolExtension.crossref.t.sol` | | |
| `SeedExecutorRouterExtension.test.js` | 22 | `SeedExecutorRouterExtension.t.sol` | | |
| `SeedProtocolExtension.gas.test.js` | 1 | `SeedProtocolExtension.gas.t.sol` | | |
| `SeedProtocol.ts` | 5 | — | | stale POC suite (M8) |

## 5. Risks and things to verify during the work

- **`lib/` collision.** thirdweb imports `lib/sstore2/...` as a bare path. The remapping handles it in the spike, but the spike had no real `lib/` directory. Re-check after `forge install`.
- **EVM version drift.** If `evm_version` doesn't match Hardhat, bytecode differs and gas numbers shift. The parity check in step 2 catches it.
- **Cheatcode vs. Hardhat semantics.** `vm.expectRevert` only applies to the next call, and `vm.prank` only to the next call too. Wrap multi-step UserOp flows in `vm.startPrank`/`stopPrank` and put the expectation right before `handleOps`.
- **ABI-decoding JSON fixtures** into nested dynamic structs (`PublishRequestData[]` with `MultiAttestationRequest[]`) through `vm.parseJson` is fiddly. Falling back to Solidity builders is fine.
- **Duplicate artifact names.** `EAS` exists in `contracts/EAS.sol`, `eas/EAS.sol` and node_modules. In Solidity tests, import from the package path; don't use `deployCode("EAS")`.
- **Foundry version on the dev machine.** Anyone on an old global forge hits the same "Unknown version" error. The README should state the required version.

## 6. Follow-ups (not in this branch)

- Deploy migration:
  - `forge script` + CREATE2 for deterministic module addresses
  - Etherscan V2 verification
  - replacing `scripts/` that depend on Hardhat
  - `USE_LOCALHOST`-style checks against anvil
  - then removing Hardhat entirely
- Upgrade solc from 0.8.27 to the latest 0.8.x, and pin pragmas.
- Fuzz and invariant tests: cross-reference fuzzing for `multiPublish`; the invariant "EAS attester == account".
- Slither and Aderyn in CI with a triaged baseline; `forge fmt` and `forge lint`.
- OZ 4.9.5 → 5.x and moving dependencies to Soldeer.
