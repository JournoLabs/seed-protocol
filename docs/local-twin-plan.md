# Plan: a local OP Sepolia twin for end-to-end development

Goal: run permapress (web and desktop), permapress-api and the local seed-protocol-sdk against a local chain that behaves like production, so integration bugs show up on a laptop instead of on OP Sepolia. This replaces the Blockscout sandbox ([local-sandbox-plan.md](local-sandbox-plan.md)) as the main local-testing goal; an explorer can be added later for viewing transactions.

## 1. The shape

A **twin** is a `hardhat node` forking OP Sepolia at a pinned block, **with its own chain id**, with this repo's rollout applied, plus local stand-ins for the hosted services the stack depends on.

| Layer | Production | Twin |
|-------|-----------|------|
| Chain | OP Sepolia via thirdweb's hosted RPC | Fork of OP Sepolia, chain id 31337 (T1), rollout applied |
| Contracts | EAS and SchemaRegistry at the OP predeploys, ManagedAccountFactory `0x76F4…`, EntryPoint v0.6 at its canonical address | Same addresses, same state (the fork), plus the new Seed contracts |
| Base schemas | Registered on OP Sepolia | Present through the fork; `seed:ensure-schemas` makes sure (T4) |
| Login | thirdweb in-app wallet (email, passkey; hosted) | Unchanged: login is chain-agnostic and works online |
| UserOps (4337) | thirdweb bundler + paymaster | Local bundler (alto) on the fork's EntryPoint v0.6; prefunded accounts or a local paymaster (T2) |
| EIP-7702 sponsored gas | thirdweb's hosted relayer | Not reproducible. The SDK's permissionless 7702 path against the local bundler, and a real-network smoke test for thirdweb's relayer (T3) |
| Reads | easscan GraphQL | `../eas-indexing-service` pointed at the twin, starting at the fork block |
| Files | upload API → seed-gateway-proxy → ar.io | permapress-api's local compose, backed by `../ar-io-node` or the operator stack |

Why a fork and not a fresh chain:
- The SDK hardcodes the OP predeploy addresses (EAS, SchemaRegistry) and the factory.
- thirdweb only accepts EntryPoints at their canonical addresses.
- The SDK expects some schemas to already be registered.

A fork has all of that already, plus real accounts and factory state, so the SDK's addresses can stay as they are.

## 2. Decisions

### T1: The twin has its own chain id
About 30 places in the SDK, and several in permapress, use thirdweb's `optimismSepolia` chain object. Its RPC, bundler and paymaster are thirdweb's hosted ones, chosen by chain id. If the twin kept 11155420, anything that missed the local config would sign a transaction that's valid on the **real** OP Sepolia and send it there, silently. With chain id 31337, the same mistake fails loudly: wrong chain id, rejected signatures, thirdweb has no endpoints for it.

### T2: Gas: prefunded first, a local paymaster later
Production sponsors gas through thirdweb's paymaster. The twin starts with prefunded accounts (`gasless: false`), which exercises everything except sponsorship. A local verifying paymaster can come later if sponsorship bugs turn out to matter.

### T3: Where the twin stops
Two things stay hosted and need a real-network smoke test as part of every release:
- thirdweb's in-app wallet login (works against the twin, but needs the internet);
- thirdweb's EIP-7702 sponsored-gas relayer.

### T4: Protocol-level schemas belong to this repo
`seed:ensure-schemas` registers the schemas the protocol itself relies on, idempotently, on any network, and `seed:verify-live` checks them. All three already exist on OP Sepolia (§8), so there it only checks; it matters for fresh chains and new networks (mainnet).
- `"bytes32 version"`
- `"bytes32 schemaId,string name"` (EAS's schema-naming schema)
- `"string storage_transaction_id"`

The list lives in `scripts/lib/schemas.ts`, exported for the SDK to import. The SDK keeps registering the schemas for user-defined models (they're dynamic), but only *checks* the base ones, and fails with a clear error if one is missing.

### T5: SDK and app changes are configuration, not forks of the code
The changes needed (§4) are making existing settings work end to end: chain, RPC, bundler, indexer endpoint. Production behaviour doesn't change when they're unset.

## 3. Twin tooling in this repo

- **`bun run twin:up`** (done, `scripts/twin.ts`). Runs in the foreground, and Ctrl-C stops everything.
  1. Starts the forking node: chain id 31337, OP Sepolia pinned at block 49,590,000. `--fork-block <n|latest>` overrides the block.
  2. Applies the rollout with the real commands, then `seed:ensure-schemas` and `seed:verify-live`.
  3. Funds five test accounts (alice … erin, 100 ETH each). Their keys are fresh, created once per checkout in `.twin/keys.json` (gitignored), so they're the same on every `up`.
  4. Starts the bundler: alto, a dev dependency, on `:4337`.
  5. Runs the smoke tests: `seed:publish-smoke` (direct and `handleOps` paths), then a UserOp **through the bundler** that deploys alice's ManagedAccount and publishes through it.
  6. Writes `.twin/twin.json` for the SDK and apps: chain id, RPC and bundler URLs, EntryPoint, every contract address, base schema UIDs, and the accounts with their keys.
- **Not started by `twin:up` yet:**
  - the EAS indexer (§9 has the design, proven by hand);
  - the seed gateway: run `../seed-protocol-server` alongside.

## 4. Changes outside this repo

**seed-protocol-sdk**
- Derive the thirdweb chain from `PublishConfig.chain` and `rpcUrl`, replacing the hardcoded `optimismSepolia` (around 30 sites). The pattern already exists in `adapters/thirdwebAccount.ts`.
- Pass `bundlerUrl` (and paymaster or `gasless`) into `inAppWallet`/`smartWallet` options.
- Make `EAS_ENDPOINT` configurable in the browser. Today the Vite plugin's `process` stub hides it.
- Fix `getArweave()`, which hardcodes `https`.
- Check, don't register, the base schemas (T4).
- **Separately, required by the rollout** (deploy plan §4): stop calling `setEas`, stop sending `multiPublish` directly from session keys, and don't grant EAS as an approved target. The twin is where these get proven against the new contracts.

**permapress**
A local-network mode driven by env vars (chain id, RPC, bundler, indexer, Arweave gateway), replacing its own hardcoded `optimismSepolia` and easscan URLs.

**permapress-api**
- `feed-publish` gets the same settings.
- It also needs a way to use the local SDK instead of the vendored 0.6.7 tarballs.

## 5. Order of work

1. **Spike** (done). Fork with its own chain id; a local bundler on EntryPoint v0.6; a thirdweb smart-wallet UserOp through it from a script, publishing via the new Seed extension. Results in §8.
2. **This repo** (done): `seed:ensure-schemas` + checks (`schemas/base-schemas.json`), and `twin:up`.
3. **SDK:** network configuration, proven with a script-driven publish against the twin; then the deploy plan §4 changes.
4. **Reads:** `eas-indexing-service` on the twin, and the SDK pointed at it.
5. **permapress** in local mode, then **permapress-api**.
6. **The real rollout** (deploy plan step 9), once the SDK changes pass on the twin.

## 6. Inputs

| ID | Input | Needed by |
|----|-------|-----------|
| I1 | OK to change the SDK and permapress as described in §4 (separate branches in those repos)? | step 3 |
| I2 | Files: is the operator stack (seed-protocol-server + ar.io) runnable locally today, or should the twin start with `../ar-io-node` alone? | step 5 |

## 7. Risks

- **Fork dependence on the RPC.** The twin forks through the Alchemy free tier: rate limits, and lazily fetched state. A pinned block keeps it deterministic, and EDR caches fetched state on disk.
- **Indexer cost.** `eas-indexing-service` must start at the fork block, not backfill OP Sepolia history. Attestations from before the fork then exist on the chain but not in the twin's indexer.
- **7702 coverage.** permapress defaults to thirdweb's 7702 path, which the twin can't host (T3).
- **Divergence.** Every local stand-in is a place the twin can differ from production. §1 lists them, so a bug found only in production can be traced to one of those rows.

## 8. Spike results (2026-10-02)

**Passed.** Each step, by hand:

1. **Fork with its own chain id.** The `op_sepolia_twin` network in `hardhat.config.ts` is EDR forking OP Sepolia with `chainId: 31337`. `eth_chainId` returns `0x7a69`, and the OP state is all there: EAS (`0x4200…21`), ManagedAccountFactory `0x76F4…` (whose `entrypoint()` is the canonical v0.6 `0x5FF1…2789`), the EntryPoint and CreateX. T1 works.
2. **Rollout on the twin.** It used the real commands:
   - `ignition deploy … --strategy create2`;
   - `seed:replace-extension --impersonate auto`;
   - `seed:verify-live` on the factory's first account: 12/12.
3. **Base schemas.** `"bytes32 version"` (`0x13c0…bdf6`), `"bytes32 schemaId,string name"` (`0x44d5…87fc`) and `"string storage_transaction_id"` (`0x55fd…e517`) are **already registered on OP Sepolia**, revocable, no resolver. The twin inherits them.
4. **Local bundler.** Pimlico alto (npm `@pimlico/alto`), run with:
   - `--entrypoints 0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789 --chain-type op-stack --safe-mode false`
   - `--max-block-range 5` (see the gotchas)

   It reports the twin's chain id and EntryPoint v0.6.
5. **thirdweb UserOp end to end.** The setup was the SDK's own thirdweb (5.121.4), with `smartWallet({ chain: defineChain({id: 31337, rpc}), factoryAddress: 0x76F4…, gasless: false, overrides: { bundlerUrl } })` and a local admin key. One UserOp:
   - deployed a new account through the real factory (initCode);
   - ran `execute(account, 0, multiPublish(...))`, routed to the new `SeedProtocolExtension`;
   - produced 3 `Attested` events with attester = the account, `UserOperationEvent.success = true`, in about 1.4 s.

   thirdweb with a non-thirdweb bundler URL uses standard bundler RPCs only and takes gas prices from the node, so no thirdweb-hosted call is involved.
6. **Today's SDK interactive path on the post-rollout contracts.** A session key was granted the way `ensureManagedSignerSessionKey` does it (`approvedTargets = [account, EAS, 0x0434… module]`). Then:
   - the key calls `multiPublish` on the account directly: `Unauthorized(sessionKey)`;
   - the key calls `setEas` (as `ensureManagedAccountEasConfigured` does): `Router: function does not exist.`;
   - an admin EOA calls `multiPublish` directly: succeeds.

   So the deploy plan's §4 prediction holds. Publishing in permapress breaks at rollout unless the SDK changes ship with it, and the twin is now a place to prove them.

**Gotchas found (these go into `twin:up`):**
- **Don't use Hardhat's well-known keys on the twin.** Everyone uses them on public testnets, so on the fork account #0 already has nonce 6,399 and real history. Use fresh random keys, funded with `hardhat_setBalance`.
- **ethers' pending-nonce lookup lags a block behind on the fork.** Back-to-back sends from one `Wallet` reuse a nonce ("Nonce too low"), so wrap it in `NonceManager`. Hardhat tasks are unaffected, because they send through the node's accounts. The SDK's viem client could hit the same problem.
- **No paymaster means the account pays.** A ManagedAccount must hold ETH before its first UserOp (`AA21 didn't pay prefund`). `twin:up` funds alice's; apps on the twin need to fund theirs, or the SDK has to handle it.
- **Log queries that reach before the fork block are forwarded to the RPC.** On the Alchemy free tier (10-block `eth_getLogs` limit) they fail with HTTP 400. alto's UserOp receipt lookup hit this; `--max-block-range 5` keeps it on local blocks. The indexer will hit the same thing: it must start at the fork block.
- **`eth_call` from an unfunded address fails on the twin**, because an OP-type node charges the L1 data fee up front. Callers that simulate from fresh addresses need a balance or a state override. `seed:verify-live` has this fix; `simulateCallFromAccount` in the SDK may need it too.

Scripts used: kept out of the repo (scratch); `twin:up` will reimplement them properly.

## 9. EAS indexer: the official one, pinned and seeded (2026-10-02)

`../eas-indexing-service` is JournoDAO's experimental fork, last synced with upstream in 2024. The twin uses the **official** indexer, [ethereum-attestation-service/eas-indexing-service](https://github.com/ethereum-attestation-service/eas-indexing-service), which is the same software as easscan, so its GraphQL is what the SDK already queries. It was proven by hand against a running twin (scratch files; not in the repo yet).

### What upstream offers, and what it lacks for the twin
- **Chain selection.** Chains are a hardcoded array (`chainConfigs.ts`), selected by `CHAIN_ID`. There's no way to define a chain from the environment, and no published Docker image; you build it yourself.
- **Upstream's build is broken today.** It has no lockfile, so dependencies float, and a transitive dependency (`brace-expansion@5`) now needs Node 20+, while upstream's Dockerfile uses Node 18.
- **Resuming.** The indexer resumes from a block counter in its Postgres (`ServiceStat.latestAttestationBlockNum`). Since the twin restarts from the same fork block on every `up`, the indexer's database must be wiped each time.
- **Polling.** Its event listener polls the RPC every few seconds, so attestations appear within seconds. `POLLING_INTERVAL` (default 60 s) is only the fallback.

### The setup
1. **Image.** Upstream cloned at a pinned commit (`9490bfa`, 2026-03-16) on `node:20-alpine`, plus a one-line overlay. The overlay appends to `chainConfigs.ts` an `EAS_CHAIN_CONFIGS.push(...)` of one config parsed from `EAS_CUSTOM_CHAIN` (JSON). Upstream's files are otherwise untouched. The build takes about 40 s.
2. **Twin chain config.** Chain id 31337, EAS `0x4200…21`, registry `0x4200…20`, `rpcProvider: http://host.docker.internal:8545`, `contractStartBlock`: fork block + 1, `POLLING_INTERVAL=5000`.
3. **Seed the pre-fork data from easscan.** This step is required.
   - Starting at the fork block alone **breaks**. The first Seed publish uses `bytes32 version`, which was registered before the fork, so the attestation insert fails a foreign-key check (`Attestation_schemaId_fkey`). The indexer only advances after a batch succeeds, so it retries the same batch forever.
   - The fix is to copy OP Sepolia's data up to the fork block's timestamp from `optimism-sepolia.easscan.org/graphql`:
     - all 792 schemas and 172 schema names, in about 1 s;
     - optionally all on-chain attestations (48,827 at block 49,590,000), in about 40 s.
   - Rows go in with `json_populate_recordset … ON CONFLICT DO NOTHING`. Attestations revoked after the fork are marked unrevoked.
   - Pages must be ordered by `(time, id)`; ordering by `time` alone overlapped pages and lost 128 rows.
4. **Result.** The indexer got past the stuck batch, indexed the twin's 9 smoke attestations, and kept up block by block. The seeded attestations match easscan field for field, and schema-name lookups (the SDK's `getSchemaUidForModel` path) work.

### To build into `twin:up` (this repo)
- `infra/eas-indexer/`: the Dockerfile, the overlay, a compose file (Postgres + indexer on `:4000`), and a **vendored `yarn.lock`** generated once, so the build is reproducible.
- `twin:up` then:
  1. runs `docker compose down -v` (fresh database) and starts Postgres and the indexer, with `EAS_CUSTOM_CHAIN` built from `twin.json`;
  2. seeds from easscan. Schemas and names always; attestations by default too (`--no-attestation-seed` to skip);
  3. waits for GraphQL, then checks that the smoke attestations are indexed;
  4. adds `easGraphqlUrl: http://localhost:4000/graphql` to `twin.json`.
- Ctrl-C stops the compose project too.
- Seeding needs internet access (easscan), like the fork itself.

### Worth offering upstream
These would let the overlay go away:
- an env-defined chain config;
- a lockfile and Node 20 in the Dockerfile;
- optionally, fetching an unknown schema from the registry instead of failing the batch, which helps anyone indexing from a later start block.
