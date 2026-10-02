# Seed Protocol contracts

Smart contracts that publish Seed Protocol data as [EAS](https://attest.org) attestations made by the user's smart account:

- `SeedProtocolExtension` / `SeedProtocolExtensionV2`: thirdweb ManagedAccount extensions (called via the account's Router).
- `SeedProtocolExecutor`: an ERC-7579 executor module, plus `SeedExecutorRouterExtension`, which lets thirdweb accounts use it.

The access-control model (who may publish, session keys, revocation) is described in [docs/security/extension-access-control-plan.md](docs/security/extension-access-control-plan.md).

## Requirements

- Node 24 (see `.nvmrc`)
- [Bun](https://bun.sh), the version pinned in `package.json` (`packageManager`)

Use `bun install`, not `npm install`. Bun applies `patches/`, which the build needs (see [Build notes](#build-notes)).

## Development

```shell
bun install
bun run build        # compile contracts and generate TypeChain types
bun run test         # all tests (Mocha + ethers, in-process network)
bun run typecheck    # type-check the config and tests
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
| `scripts/` | Utility and deploy scripts (see below) |
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
| `ETHERSCAN_API_KEY` | `hardhat verify` |

They're only resolved when a task needs them; building and testing need none.

## Scripts and deployment

Deployment is being reworked per [docs/deploy-plan.md](docs/deploy-plan.md). `bun run rehearse:local` runs the whole rollout against a throwaway `hardhat node`.

`scripts/get_4_byte_selectors.ts` doesn't depend on Hardhat and runs with `bun`. `scripts/decode_attestation_data.ts` is an unported Hardhat 2 scratch script, pending a keep-or-delete decision (deploy plan, I6).
