# Hardhat 3 migration plan

Branch: `chore/migrate-to-hardhat3` (from `fix/extension-access-control` @ `b49f981`)
Scope: move **build and tests** from Hardhat 2 to Hardhat 3, keeping the tests in TypeScript/JavaScript. Contract behaviour is out of scope: no Solidity changes under `contracts/`. The deploy process is the next branch (§6).

Why Hardhat 3 and not Foundry:
- The maintainer works mainly in TypeScript.
- The most valuable test code (`managedAccountFixture.js`: EIP-712 session keys, v0.6 UserOps, event parsing) is natural in TS and awkward in Solidity.
- Hardhat 3 also runs Solidity tests written with forge-std, including fuzz tests, so we can add them where they pay off without moving everything.

## 1. Starting point

| Area | Today |
|------|-------|
| Build | Hardhat 2.28. In practice everything compiles with solc 0.8.27, `evmVersion: paris`, optimizer 200 (read from `artifacts/build-info`). `lib/sstore2/` is remapped through a `TASK_COMPILE_GET_REMAPPINGS` subtask override. |
| Tests | 6 Mocha/Chai suites in CommonJS JS, **116 passing tests** (baseline on `b49f981`; access and crossref generate tests in loops for both extensions). `npm test` runs 5 suites (111); the gas suite (5) runs separately, plus `test/SeedProtocol.ts`, a stale POC suite with 5 tests that isn't run. |
| Fixtures | `easFixture.js`, `executorEASFixture.js`, `extensionEASFixture.js`, `managedAccountFixture.js`, plus `gas_payloads.ts` and the `multi_publish_*.json` payloads. |
| Hardhat-specific test APIs | `loadFixture` (~50 call sites), `.to.be.reverted` (11), `revertedWith` (4), `time.increase`, `impersonateAccount`, `setBalance`, `staticCall`, plus `hre.ethers` everywhere. |
| Plugins | toolbox v4, plus `@nomiclabs/hardhat-ethers` and `@nomiclabs/hardhat-etherscan` (the old v5-era plugins, which conflict with the current ones), `hardhat-upgrades` v3, `hardhat-ethernal`, gas reporter, solidity-coverage, typechain. |
| Scripts | 18 files in `scripts/` import `hardhat`; 9 read `artifacts/` or `eas/*.json`. |
| Node | Local v25.9.0. Hardhat 3 needs ≥ 22.13. |

### Spike result (scratchpad, not committed)
A fresh Hardhat 3.18 project with `@nomicfoundation/hardhat-toolbox-mocha-ethers` 4.0, our `contracts/`, and the same npm Solidity deps:
- **Builds** with solc 0.8.27 and `evm target: paris`, but only after two changes (H2, H3):
  1. **thirdweb's bare import `lib/sstore2/...` fails** with HHE902. In Hardhat 3, a `remappings.txt` only applies to files in its own directory and below, so the root file can't fix an import inside `node_modules` (the remapping the error message suggests doesn't work). Putting `remappings.txt` *inside* `@thirdweb-dev/dynamic-contracts` with `lib/sstore2/=lib/sstore2/` works.
  2. **No artifacts for npm contracts.** Hardhat 3 only writes artifacts for project sources. The import-only wrappers (`contracts/EAS.sol`, `contracts/SchemaRegistry.sol`, `contracts/test/ThirdwebHarness.sol`) no longer produce `EAS`, `SchemaRegistry`, `EntryPoint`, `ManagedAccountFactory`, `ManagedAccount` or `AccountExtension`. Listing them in `solidity.npmFilesToBuild` fixes it.
- **Mocha + ethers runs** under `hardhat test mocha`, including `networkHelpers.loadFixture`, `deployContract` by name, and `revertedWithCustomError` (it decoded the revert correctly).
- **Vitest runs too:** `import { network } from "hardhat"` inside a Vitest file deploys EAS and uses `networkHelpers.time`. See H6 for why it still isn't the default.

## 2. Decisions

### H1: Mocha + ethers via `@nomicfoundation/hardhat-toolbox-mocha-ethers`
This is the smallest change to the existing tests. Chai matchers, `loadFixture`, ethers v6 contract objects and the `describe`/`it` structure all carry over.

The toolbox bundles:
- `hardhat-mocha` (the runner)
- `hardhat-ethers`
- `hardhat-ethers-chai-matchers`
- `hardhat-network-helpers`
- `hardhat-verify`
- `hardhat-typechain`
- `hardhat-keystore`
- `hardhat-ignition` (+ `-ethers`)

viem and `node:test` are Hardhat's newer default. They're a reasonable later step, but switching now would rewrite every assertion for no gain in coverage.

### H2: thirdweb's `lib/sstore2/` import is fixed with `bun patch`
- Run `bun patch @thirdweb-dev/dynamic-contracts` and add `remappings.txt` with `lib/sstore2/=lib/sstore2/` to the package.
- Commit the resulting patch file. `bun install` re-applies it, locally and in CI.
- The `TASK_COMPILE_GET_REMAPPINGS` override goes away.
- If thirdweb ever ships its own `remappings.txt`, the patch can be dropped.

### H3: npm contracts are compiled through `npmFilesToBuild`
```ts
npmFilesToBuild: [
  "@ethereum-attestation-service/eas-contracts/contracts/EAS.sol",
  "@ethereum-attestation-service/eas-contracts/contracts/SchemaRegistry.sol",
  "@thirdweb-dev/contracts/prebuilts/account/managed/ManagedAccountFactory.sol",
  "@thirdweb-dev/contracts/prebuilts/account/managed/ManagedAccount.sol",
  "@thirdweb-dev/contracts/prebuilts/account/utils/AccountExtension.sol",
  "@thirdweb-dev/contracts/prebuilts/account/utils/Entrypoint.sol",
]
```
- The wrapper files `contracts/EAS.sol`, `contracts/SchemaRegistry.sol` and `contracts/test/ThirdwebHarness.sol` become redundant. Delete them.
- `eas/` isn't a source directory, so leave it for the deploy branch to decide.
- Tests and `scripts/utils/deploy.ts` keep resolving `getContractFactory("EAS")` by name, as long as the name stays unique.

### H4: Same compiler settings, checked by bytecode parity
- `version: "0.8.27"`, `evmVersion: "paris"`, optimizer on with 200 runs, set explicitly in the config.
- Gate: before deleting Hardhat 2's `artifacts/`, copy it aside. Then compare deployed bytecode, metadata hash stripped, against Hardhat 3's output for:
  - `SeedProtocolExecutor`
  - `SeedProtocolExtension`
  - `SeedProtocolExtensionV2`
  - `SeedExecutorRouterExtension`
- Upgrading solc and the EVM target belongs with the deploy work, not here.

### H5: Tests become TypeScript ESM, one suite per commit
Hardhat 3 requires ESM (`"type": "module"`), so every test file changes anyway.
- Each `*.test.js` is converted to `*.test.ts` in the same commit, with TypeChain types available through the toolbox.
- Fixture modules stop importing a global `ethers`. They take a connection, or are created per file from `const { ethers, networkHelpers } = await network.create()`.
- Each port keeps every `it` (checklist in §4).

### H6: Not Vitest, for now
It works (spike), and Vitest is a perfectly normal choice in TypeScript generally. For this project it means leaving the supported path:
- **No official runner plugin.** Vitest runs outside `hardhat test`, so we'd lose:
  - Solidity and TS tests in one command;
  - auto-compiling before tests (we'd add a Vitest `globalSetup` that runs `hardhat build`);
  - Hardhat's built-in `--coverage` and gas statistics, which work through Hardhat's own runner plugins.
- **Different assertions.** Hardhat's chai matchers (`revertedWithCustomError`, `emit`, `changeEtherBalance`) are chai plugins. Under Vitest's `expect` they'd need extra setup or rewriting.
- **Few examples.** Almost none of the Hardhat docs, examples or community code use Vitest, so you'd be debugging it alone.

Revisit if Hardhat ships a Vitest plugin. If we want a lighter, Vitest-like runner later, `node:test` is the officially supported one.

### H7: Drop `USE_LOCALHOST` mode for now
It depends on `setup_local.ts` (a deploy script). Hardhat 3 makes it easy to bring back with `network.create({ network: "localhost" })`, so it returns with the deploy branch.

### H8: `test/SeedProtocol.ts` is deleted, not ported
It targets the original POC contracts, isn't run by `npm test`, and the executor and extension suites cover what it tested. *(Default; say if you want it kept.)*

### H9: Scripts are migrated in the deploy branch, not here
Hardhat 2 is removed in this branch, so the 18 scripts that import `hardhat` stop running until the deploy branch ports or replaces them.
- Many are obsolete after the access-control work, e.g. the `deployProxy`/`upgradeProxy` scripts, which D3 replaces.
- Porting them twice isn't worth it.
- `@openzeppelin/hardhat-upgrades` and `hardhat-ethernal` are dropped here.

**Alternative:** if you need a working deploy script in the meantime, port `deploy_executor_and_mock.ts` only (step 7).

## 3. Work breakdown (one commit each)

0. **Prereqs.**
   - Pin Node in `.nvmrc`. Use 24 LTS rather than 25 (odd-numbered Node releases aren't LTS, and CI should use LTS).
   - Save Hardhat 2 output for the parity check: `npx hardhat clean && npx hardhat compile`, then copy `artifacts/` to a directory outside the repo.

1. **Swap Hardhat 2 for Hardhat 3.**
   - Remove all Hardhat 2 packages:
     - `hardhat`
     - `@nomicfoundation/*`
     - `@nomiclabs/*`
     - `@typechain/*`, `typechain`
     - `hardhat-gas-reporter`, `solidity-coverage`
     - `hardhat-ethernal`, `hardhat-erc1820`
     - `@openzeppelin/hardhat-upgrades`
     - `@ethersproject/providers`
     - `ts-node`
     - chai 4, `@types/mocha`
   - Add:
     - `hardhat@^3`
     - `@nomicfoundation/hardhat-toolbox-mocha-ethers`
     - its peer deps: `chai@^5`, `mocha@^12`, `ethers@^6.14`, and the plugin packages it lists
   - `package.json`: `"type": "module"`, and rename the package from `perma-press-contracts`.
   - `tsconfig.json`: switch to the Hardhat 3 template (`module`/`moduleResolution: node16`, `target: es2022`), and drop `mocha` from `types` in favour of the toolbox's.
   - New `hardhat.config.ts` using `defineConfig`:
     - `plugins: [toolbox]`
     - `paths.sources: "./contracts"`
     - the H4 compiler settings
     - the H3 `npmFilesToBuild`
     - networks: the in-process default plus `optimism_sepolia` as `type: "http"`, with `configVariable("OPTIMISM_SEPOLIA_RPC_URL")` / `configVariable("DEV_KEY")` instead of `process.env`/dotenv
   - Gate: config loads (`npx hardhat --help`).

2. **Fix the Solidity build (H2, H3).**
   - Apply the `bun patch` for `@thirdweb-dev/dynamic-contracts`.
   - Delete the wrapper `.sol` files.
   - Gate: `npx hardhat build` is clean.

3. **Bytecode parity (H4).**
   - Add `scripts/check_bytecode_parity.ts`, comparing the saved Hardhat 2 artifacts with `artifacts/` (metadata stripped).
   - Record the result here. The script can be deleted once green.

4. **Shared fixtures to ESM.**
   - Convert `easFixture`, `executorEASFixture`, `extensionEASFixture` and `managedAccountFixture` to `.ts` modules that take `{ ethers, networkHelpers }` from the caller's connection.
   - Mechanical changes:
     - `require` → `import`
     - `ethers.provider.getBlock` → `connection.ethers.provider.getBlock`
     - `time.increase` → `networkHelpers.time.increase`
     - `impersonateAccount`/`setBalance` → `networkHelpers.*`
   - `managedAccountFixture` (425 lines) is the biggest file, but its logic doesn't change: the EIP-712 signing, UserOp building and `handleOps` calls stay as they are.

5. **Port the suites, one commit each, in this order:**
   1. `ManagedAccountHarness` (12): proves the fixture port
   2. `SeedProtocolExecutor` (39): also removes the `USE_LOCALHOST` branches (H7)
   3. `SeedProtocolExtension.access` (9)
   4. `SeedProtocolExtension.crossref` (10)
   5. `SeedExecutorRouterExtension` (22): re-apply the router-guard mutations from the access-control branch and confirm they still fail tests before calling it done

   Mechanical changes per suite:
   - `.to.be.reverted` → `.to.be.revert(ethers)`
   - `.revertedWithoutReason()` → `.revertedWithoutReason(ethers)`
   - `loadFixture` → `networkHelpers.loadFixture`
   - `const { ethers } = require("hardhat")` → `const { ethers, networkHelpers } = await network.create()`

6. **Gas and coverage.**
   - Port `SeedProtocolExtension.gas.test.js` and `gas_payloads.ts`.
   - `test:gas` → `hardhat test --gas-stats`.
   - Add `coverage` → `hardhat test --coverage`.
   - Delete `gas_benchmark.ts`, `compare_gas_reports.ts`, `gasReporterOutput.json` and the `gas:*` scripts. They're `hardhat run` scripts built on Hardhat 2 APIs. If before/after comparison is still wanted, rebuild it with the deploy branch.
   - Hardhat 3's gas statistics are a new baseline; don't compare them with old `gas-reports/`.

7. **Scripts (H9).**
   - Delete the scripts that the access-control plan already marks obsolete (`deploy_optimism_sepolia*.ts`, `upgrade_optimism_sepolia.ts`).
   - Add a header comment to the rest saying "Hardhat 2 script, ported in deploy branch".
   - Optional: port `deploy_executor_and_mock.ts` if a working deploy is needed before then.

8. **CI.** Add `.github/workflows/test.yml`:
   - Node from `.nvmrc`
   - `oven-sh/setup-bun`
   - `bun install --frozen-lockfile` (applies the thirdweb patch)
   - `npx hardhat build`
   - `npx hardhat test`

9. **Docs.**
   - Replace the README's Hardhat-sample text and its "Local development" section with build/test/coverage/gas commands.
   - Note that the deploy scripts are pending.
   - Fill in §4.

## 4. Test mapping checklist

The port is done when the Hardhat 3 run reaches the same **116 passing**.

| Suite | Tests (HH2 baseline) | Hardhat 3 file | Ported | Dropped (reason) |
|-------|-----------:|----------------|-------:|------------------|
| `ManagedAccountHarness.test.js` | 12 | `ManagedAccountHarness.test.ts` | | |
| `SeedProtocolExecutor.test.js` | 39 | `SeedProtocolExecutor.test.ts` | | localhost-mode branches (H7) |
| `SeedProtocolExtension.access.test.js` | 18 | `SeedProtocolExtension.access.test.ts` | | |
| `SeedProtocolExtension.crossref.test.js` | 20 | `SeedProtocolExtension.crossref.test.ts` | | |
| `SeedExecutorRouterExtension.test.js` | 22 | `SeedExecutorRouterExtension.test.ts` | | |
| `SeedProtocolExtension.gas.test.js` | 5 | `SeedProtocolExtension.gas.test.ts` | | |
| `SeedProtocol.ts` | 5 | — | | stale POC suite (H8) |

## 5. Risks and things to verify

- **Fixture snapshots are per connection.** `loadFixture` reverts to a snapshot on the connection it was first called with. Each test file should create one connection at the top and share it with its fixtures, never call `network.create()` inside a fixture.
- **The thirdweb patch is easy to forget.** If someone runs `npm install` instead of `bun install`, the patch isn't applied and the build fails with HHE902. Make the package manager explicit: a `packageManager` field plus a README note.
- **Chain ID.** The Hardhat 2 config sets `chainId: 1337` for the in-process network. Tests compute EIP-712 domains from the live chain ID, so this shouldn't matter, but `deployments/localhost.json` and `setup_local.ts` assume 1337 (deploy branch).
- **Node 25.** Hardhat 3 supports Node ≥ 22.13, and the spike ran on 25.9. Pinning to 24 LTS avoids surprises from odd-numbered releases.
- **TypeChain output location and naming** may differ from Hardhat 2's `typechain-types/`. Only `scripts/` imports those types today.

## 6. Follow-ups (not in this branch)

- Deploy branch:
  - port or replace `scripts/` (Hardhat Ignition, or plain TS scripts over `network.create()`)
  - Etherscan V2 verification via `hardhat-verify` v3
  - CREATE2 for deterministic module addresses
  - bring back the `USE_LOCALHOST`-style checks
  - decide on `eas/`
- Solidity fuzz tests for `multiPublish` cross-references (forge-std installed via npm, `*.t.sol` alongside the TS tests), and the invariant "EAS attester == account".
- Upgrade solc from 0.8.27 to the latest 0.8.x and the EVM target from `paris`, and pin pragmas.
- Slither and Aderyn in CI with a triaged baseline.
- OZ 4.9.5 → 5.x.
- Optional: move from Mocha + ethers to `node:test` + viem.

## 7. Progress log

- **Step 0 (`.nvmrc`):** Node 24 pinned. Hardhat 2 baseline: 116 passing in the 6 suites. `test/SeedProtocol.ts` fails in its `before all` hook because it calls the extension's removed `initialize` through `deployProxy`; it's deleted in step 5 (H8).
- **Step 1:** Hardhat 3.18.1 with `hardhat-toolbox-mocha-ethers` 4.0.0. The config loads and type-checks. The in-process network keeps `chainId: 1337`. `allowUnlimitedContractSize` is dropped, since every contract is under 24 KB.
- **Step 2:** `bun patch` for `@thirdweb-dev/dynamic-contracts@1.2.5` (re-applies on a clean install), and the wrapper `.sol` files are removed. `hardhat build` is clean: 17 files, solc 0.8.27, `paris`. The only warnings are thirdweb's (payable fallback without receive).
- **Step 3 (bytecode parity):** all 14 deployable artifacts, the 4 production contracts plus EAS, SchemaRegistry, the thirdweb account stack, the mock and the libraries, match Hardhat 2 in both runtime and initcode once metadata is blanked. For the production contracts the raw bytecode has the same length and differs only inside the CBOR metadata blob. Negative control: a build with `runs: 999` makes the script report all 4 production contracts as different and exit 1.
