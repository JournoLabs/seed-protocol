# Seed Protocol contracts

Smart contracts that publish Seed Protocol data as [EAS](https://attest.org) attestations made by the user's smart account:

- `SeedProtocolExtension` / `SeedProtocolExtensionV2`: thirdweb ManagedAccount extensions (called via the account's Router).
- `SeedProtocolExecutor`: an ERC-7579 executor module, plus `SeedExecutorRouterExtension`, which lets thirdweb accounts use it.

See [Security model](#security-model) for who may publish, and [docs/security/extension-access-control-plan.md](docs/security/extension-access-control-plan.md) for the reasoning behind it.

## Requirements

- Node 24 (see `.nvmrc`)
- [Bun](https://bun.sh), the version pinned in `package.json` (`packageManager`)

Use `bun install`, not `npm install`. Bun applies `patches/`, which the build needs (see [Build notes](#build-notes)).

## Development

```shell
bun install
bun run build        # compile contracts and generate TypeChain types
bun run test         # all tests (Mocha + ethers, in-process network)
bun run typecheck    # type-check the config, Ignition modules, scripts and tests
bun run test:gas     # tests with gas usage statistics
bun run coverage     # tests with coverage (HTML report in coverage/html)
```

Run a single suite with `npx hardhat test mocha test/SeedProtocolExecutor.test.ts`.

CI (`.github/workflows/test.yml`) runs build, type-check and tests on pushes to `main` and on pull requests.

## Layout

| Path | Contents |
|------|----------|
| `contracts/` | Production contracts, plus `mocks/MockERC7579Account.sol` |
| `interfaces/` | EAS and Seed Protocol interfaces |
| `test/` | Test suites (`*.test.ts`) |
| `test/fixtures/` | Shared fixtures: EAS + schemas, the thirdweb ManagedAccount stack (EntryPoint, factory, session keys, UserOps), gas payloads |
| `ignition/modules/` | Ignition modules: `SeedProtocol` (what gets deployed) and `LocalStack` (a stand-in OP Sepolia for rehearsals) |
| `ignition/parameters/` | Per-network module parameters, plus `SeedRollout.factory` for the rollout tasks |
| `ignition/deployments/` | Ignition's deployment records: the one place deployed addresses live |
| `scripts/` | Rollout tasks and the rehearsal driver (see [Deployment](#deployment)); shared code in `scripts/lib/` |
| `docs/` | Plans and design notes |

## Build notes

This project uses Hardhat 3. Two things in the setup aren't obvious:

- **The thirdweb patch.** `@thirdweb-dev/dynamic-contracts` imports `lib/sstore2/...` as a bare path. Hardhat 3 only resolves that through a `remappings.txt` inside the package itself, so `patches/` adds one. Without it the build fails with `HHE902`.
- **`npmFilesToBuild`.** Hardhat 3 only writes artifacts for project sources, so `hardhat.config.ts` lists the npm contracts the tests deploy by name: EAS, SchemaRegistry and the thirdweb account stack.

Compiler settings are solc 0.8.27, EVM target `paris`, optimizer 200 runs. These are the same as the earlier Hardhat 2 build, which produced identical bytecode (metadata hash aside).

## Secrets

Network credentials are read with Hardhat's `configVariable()`, from the environment or a local `.env` file:

| Variable | Used for |
|----------|----------|
| `OPTIMISM_SEPOLIA_RPC_URL`, `DEV_KEY` | `--network optimism_sepolia` |
| `OPTIMISM_SEPOLIA_RPC_URL` | `rehearse:op-sepolia` (the forking node) |
| `ETHERSCAN_API_KEY` | `ignition deploy --verify`, `hardhat verify` |

They're only resolved when a task needs them; building and testing need none.

## Security model

The Seed extensions run inside the user's thirdweb ManagedAccount: account fallback → factory Router → `delegatecall` into the extension. The Router does no authorization, so the extensions check callers themselves.

**Who may call `multiPublish`** (`SeedAccountAuth`):
- an account admin, calling the account directly;
- the account's EntryPoint, i.e. a UserOp signed by an admin;
- the account itself (`address(this)`), via `execute`/`executeBatch`. This is how session keys publish.

Anyone else gets `Unauthorized(caller)`.

**Other rules:**
- **EAS is pinned.** Each extension takes the EAS address in its constructor. There's no `setEas`; changing EAS means deploying a new extension and calling `replaceExtension` on the factory.
- **Everything published is revocable.** `multiPublish` makes every seed, version and property attestation revocable, whatever the request says, so the owner can always revoke what a delegate published. Seed and property schemas must be registered as revocable.
- **Delegates can't revoke.** No path a session key can reach revokes attestations. Owners revoke directly with `execute(EAS, 0, revoke(...))`.
- **The executor path** (`SeedProtocolExecutor` via `SeedExecutorRouterExtension`) trusts one executor and one EAS, both fixed when the factory admin registers the extension. Account admins only opt in (`installSeedExecutor`) or out. The executor can only `attest`/`multiAttest` on that EAS, with value passed through exactly.
- **Factory changes need `EXTENSION_ROLE`** on the ManagedAccountFactory (`replaceExtension`, `addExtension`, `removeExtension`).

### Session keys

thirdweb's session keys let a third party publish as the account until the owner revokes them.

- **Grant.** The account admin signs a `SignerPermissionRequest` for the delegate with a time window, a native-token limit and `approvedTargets`:
  - `[account]` to publish with `multiPublish`;
  - `[executor]` only, to publish through the executor (after `installSeedExecutor`).

  Never include EAS or `address(0)`: either lets the delegate call EAS directly, which bypasses forced revocability.
- **Publish.** The delegate signs a UserOp calling `execute(account, 0, multiPublish(...))` (or `execute(executor, …)` on the executor path). Calling the account directly from the session key, without a UserOp, is rejected.
- **Revoke.** The admin signs a new request with no targets, or lets the window expire. The EntryPoint then rejects the delegate's UserOps (`AA24`).

`test/ManagedAccountHarness.test.ts` and `test/SeedProtocolExtension.access.test.ts` pin this down against the real account stack.

## Deployment

The plan, inputs and progress for the OP Sepolia rollout are in [docs/deploy-plan.md](docs/deploy-plan.md). Contracts are deployed with Hardhat Ignition through [CreateX](https://github.com/pcaversaccio/createx), using a salt only the Seed deployer can use, so addresses are deterministic and can't be squatted.

### Rehearsals

```shell
bun run rehearse:local
```

Starts a throwaway `hardhat node`, deploys `LocalStack` (EAS, EntryPoint, a ManagedAccountFactory with the old Seed registration, one account), then runs every rollout command below against it and publishes through the result.

```shell
bun run rehearse:op-sepolia -- --account <test account> --admin <its admin>
```

The same against a node forking OP Sepolia, using the real factory from `ignition/parameters/optimism_sepolia.json` and impersonating its `EXTENSION_ROLE` holder. `--account`/`--admin` are optional; without them it only publishes from a fresh account it creates on the real factory.

### Tasks

All take `--network`. The rollout tasks read `ignition/parameters/<network>.json` by default.

| Task | What it does | Writes? |
|------|--------------|---------|
| `seed:predict-addresses` | Where the create2 deploy will put each contract, and whether CreateX would succeed there | no |
| `seed:extension-payload` | Prints the Router `Extension` structs for a deployment | no |
| `seed:replace-extension` | Snapshots the factory's routing to `routing-before.json`, then replaces the Seed extension and adds the executor router in one `multicall`, and reads it all back. If the signer lacks `EXTENSION_ROLE`, prints the call to submit by hand. `--dry-run`, `--check-only` | yes |
| `seed:verify-live --account <a>` | Static access-control and routing checks against a live account | no |
| `seed:publish-smoke` | Admin and session-key publishes through the live routing (simulated networks only) | yes |
| `seed:debug-publish --account <a> --payload <file>` | Simulates `multiPublish` and decodes the revert | no |

### OP Sepolia rollout

```shell
npx hardhat seed:predict-addresses --network optimism_sepolia
npx hardhat ignition deploy ignition/modules/SeedProtocol.ts --network optimism_sepolia --strategy create2 --parameters ignition/parameters/optimism_sepolia.json --verify
npx hardhat seed:replace-extension --network optimism_sepolia --dry-run
npx hardhat seed:replace-extension --network optimism_sepolia
npx hardhat seed:verify-live --network optimism_sepolia --account <test account>
```

Rollback is `replaceExtension` back to the implementation in `routing-before.json` (and `removeExtension("SeedExecutorRouterExtension")`). The old implementations are vulnerable, so roll back only for a breaking failure.

## Other scripts

`scripts/get_4_byte_selectors.ts` doesn't depend on Hardhat and runs with `bun`. `scripts/decode_attestation_data.ts` is an unported Hardhat 2 scratch script, kept pending review and left out of the type-check.
