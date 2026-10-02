# Sample Hardhat Project

This project demonstrates a basic Hardhat use case. It comes with a sample contract, a test for that contract, and a script that deploys that contract.

## Local development and executor tests

- **One-command setup**: Run `bun run setup:local` to start a Hardhat node (if not already running), deploy EAS, SchemaRegistry, schemas, SeedProtocolExecutor, and MockERC7579Account to localhost, and save all addresses and schema UIDs to `deployments/localhost.json`. Use `--force` to re-deploy when the manifest already exists.
- **Tests (hybrid)**:
  - Default: `bun run test` (or `npx hardhat test test/SeedProtocolExecutor.test.js`) runs executor tests against an in-process EAS fixture — no node or prior setup required.
  - Against localhost: Run `bun run setup:local` first, then `bun run test:localhost` (or `USE_LOCALHOST=1 npx hardhat test test/SeedProtocolExecutor.test.js --network localhost`) to run the same tests using the deployed contracts and manifest.

Try running some of the following tasks:

```shell
npx hardhat help
bun run test
bun run setup:local
bun run test:localhost
REPORT_GAS=true npx hardhat test
npx hardhat node
npx hardhat run scripts/deploy.ts
```
