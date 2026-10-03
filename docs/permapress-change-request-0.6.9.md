# Permapress change request: SDK 0.6.9 and the new Seed executor

**To:** permapress (app) and permapress-api (`services/feed-publish`) · **From:** seed-protocol contracts · **Chain:** OP Sepolia

## Why

The new Seed contracts are live on OP Sepolia. The ManagedAccountFactory was switched on 2026-10-03 (tx `0xce3b77ed0a1805f526cb9766e8d1e46c745cecf0704989ee58a1c186734be314`). That affects every account on the factory:

| | Before | Now |
|---|---|---|
| Account `multiPublish` | string `publishLocalId`, selector `0x31e19cb8` | `publishIndex`, selector `0x2a29fadc` (the old one is no longer routed) |
| Seed executor | `0x043462304114da543add6B693c686B7d98865F3E` | `0x80562aeEe4F16473779b1474D8D32d114D302e94` |
| Executor request struct | `seedUid, versionUid, seedSchemaUid, versionSchemaUid` | `seedUid, seedSchemaUid, versionUid, versionSchemaUid` (same as the account's) |

On `@seedprotocol/publish` 0.6.8, both publishing paths now fail: interactive (account) publishes revert, and automation publishes go to the wrong executor with the old field order. **0.6.9** (on npm) encodes both correctly.

## Changes

### permapress (app)
1. **Upgrade the `@seedprotocol/*` packages to `0.6.9`** (`package.json` pins `@seedprotocol/publish` at `0.6.8`), and refresh the lockfile.
2. **Set `VITE_MODULAR_ACCOUNT_MODULE_CONTRACT=0x80562aeEe4F16473779b1474D8D32d114D302e94`** everywhere the app is built: the local `.env` (it still has the old `0x0434…`) and the hosted build's environment.
3. **Check for removed SDK exports.** 0.6.9 drops `encodeMultiPublishInteger`, `transformPayloadToIntegerIds`, the `RequestWithStringIds` / `RequestWithIntegerIds` types and the `useIntegerLocalIds` option. We found no uses in permapress, but please confirm after upgrading.

### permapress-api (`services/feed-publish`)
1. **Upgrade `@seedprotocol/publish` and `@seedprotocol/sdk` to `0.6.9`** in `services/feed-publish/package.json`. The `vendor/seedprotocol-*-0.6.7.tgz` tarballs look stale; delete or refresh them so nothing installs the old encoder.
2. **Set `MODULAR_ACCOUNT_MODULE_CONTRACT=0x80562aeEe4F16473779b1474D8D32d114D302e94`** in every deployed environment. It must equal the app's `VITE_MODULAR_ACCOUNT_MODULE_CONTRACT`.
3. **Treat grants without a recorded executor as outdated.** Grants enrolled for `0x0434…` already get your 409 ("set up for an older Seed executor… Turn on again to renew"). Grants with no `executorAddress` currently go through, but every one of them predates the new executor, so their UserOps will revert. Return the same 409 for them, or migrate them.

### What users will see
Feed automation has to be turned on again: that installs the new executor on the account and grants a session key whose only approved target is `0x8056…`. Interactive publishing needs nothing from users beyond the app update.

### Not affected
The twin setup: `scripts/twin-env.mjs` and permapress's twin plugin read the executor from `.twin/twin.json`.

## Verification (rollout step 9.5)

Once both changes are deployed, please run these from permapress on OP Sepolia and send us the transaction hashes. We'll check them on-chain; if one fails, `hardhat seed:explain-userop --tx <hash>` decodes why.

| Test account | Admin (login) | What to run |
|---|---|---|
| `0x25B171f3315EBF64F0B878f1d979e9b875b86FFd` (existing; has an old session key for `0x0434…` only) | `0x8436cdD8b5357258ecb93BF1367440B93A0c47F8` | An interactive publish with a relation, then turn on feed automation and let it publish once |
| `0x803e4b34688467699B5B73D6e80fa9e8EC401aD3` (new, not deployed yet) | `0x463723fA773738e2a6e916C13F2368D5777EE40C` | A first publish (this deploys the account), then the same automation step |

The first account tests the upgrade path: automation must install the new executor and grant a new key, not reuse the old one.

## Addresses (OP Sepolia, all verified on Etherscan)

| Contract | Address |
|---|---|
| `SeedProtocolExecutor` (the one to configure) | `0x80562aeEe4F16473779b1474D8D32d114D302e94` |
| `SeedProtocolExtension` (routed by the factory) | `0xde5F3133D9A4a4957ad44b4C8d44D0cfaf0A4A6B` |
| `SeedExecutorRouterExtension` (routed by the factory) | `0xeE9CA71f3a91fC2832cc031318F0Bc4B3908D30a` |
| ManagedAccountFactory (unchanged) | `0x76F47D88bfaf670F5208911181fCDC0E160cb16d` |
