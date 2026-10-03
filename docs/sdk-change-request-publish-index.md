# SDK change request: encode `multiPublish` with `publishIndex`

**To:** seed-protocol-sdk · **From:** seed-protocol contracts · **Against:** SDK `v0.6.8` (`c394019`) · **Needed before:** OP Sepolia rollout step 9.3 (the router switch)

## Why

The contracts now have one Seed extension, `SeedProtocolExtension`, and its `multiPublish` takes the cross-reference target as an index (`publishIndex`, the target's position in the batch) instead of a string (`publishLocalId`). It's the contract that used to be `SeedProtocolExtensionV2`, and its request struct is the same one `SeedProtocolExecutor` already takes.

| | `multiPublish` selector | Routed after the rollout? |
|---|---|---|
| String `publishLocalId` (what 0.6.8 sends on the account) | `0x31e19cb8` | **No** |
| `publishIndex` (extension and executor) | `0x2a29fadc` | Yes |
| 0.6.8's `multiPublishIntegerAbi` (`useIntegerLocalIds`) | `0xd688e801` | No contract has it |

So once the factory is switched, every interactive (account) publish from 0.6.8 reverts. The executor (automation) path already sends `0x2a29fadc` and is unaffected. There are no production users, so we'd like to switch as soon as an SDK release sends the new shape.

Nothing changes in the SDK's data model: `localId` / `seedLocalId` stay strings everywhere, and `localId` is still sent (the contract carries it but doesn't read it). Only the encoder converts references to indexes.

## Changes

### 1. `encodeMultiPublish` sends the `publishIndex` ABI
`packages/publish/src/helpers/contracts/index.ts`, `helpers/abi/publisher.ts`

- Keep the input type (`MultiPublishRequest`, with string `localId` and `propertiesToUpdate[].publishLocalId`), so `createAttestations.ts:396` and other callers don't change.
- Encode with the struct `encodeExecutorMultiPublish` already uses: `localId` stays `string`; `propertiesToUpdate` becomes `(uint256 publishIndex, bytes32 propertySchemaUid)[]`. Update `multiPublishAbi` accordingly (or reuse the executor ABI's tuple). Expected selector: `0x2a29fadc`.
- Compute indexes inside the encoder, from the same `requests` array it encodes. Never earlier, never from a different array.

### 2. One strict localId → index helper, used by both encoders
The contract rejects an index that's out of range, points at an earlier request, or doesn't land on exactly one entry for the property. What it can't catch is a wrong index that lands on a *different* request with that same property (two posts with an `author` relation): that writes the reference into the wrong item. So the encoder must never guess:

- **Throw** if a `propertiesToUpdate` entry's `publishLocalId` is missing, empty, or not a `localId` in `requests`. Include the localId in the message.
- **Throw** on a duplicate `localId` in `requests`. (The old string contract wrote to every match; an index map silently keeps the last.)
- **Never default to index 0.**

`encodeExecutorMultiPublish` currently *drops* unresolved references; its comment says that matches the extension, but the hardened extension reverts (`UnknownPublishLocalId`). Make it strict too.

Please check the single-transaction path (`createAttestations.ts`, around line 502). It doesn't run `filterPropertiesToUpdateForBatch`, and when `requestData` isn't an array it sends only `normalizedRequests[0]`, so any reference from that request to another one would now throw client-side. Before, it reverted on-chain on the account path and was silently dropped on the executor path. If cross-batch references are expected there, filter them explicitly before encoding; otherwise the throw is the right behavior. The sequential path already filters per batch.

### 3. Remove the integer path
None of it matches a contract, and two helpers default an unknown reference to index 0:
- `useIntegerLocalIds` (`config.ts:155`, `:350`, `:417`; not read anywhere)
- `encodeMultiPublishInteger`, `MultiPublishIntegerRequest`, `multiPublishIntegerAbi`
- `transformPayloadToIntegerIds`, `transformPayloadForExecutor` (`helpers/transformPayloadToIntegerIds.ts`, and their tests in `packages/sdk/__tests__/helpers/`)

These are public exports (`index.ts:85-86`, `:155-158`), so call it out in the changelog.

### 4. Optional
Keep `UnknownPublishLocalId` in `seedErrorsAbi`; it still decodes reverts from the old contract.

### Not affected
The SDK database and `getPublishPayload`, the direct-to-EAS path (resolves references client-side), the executor ABI, and the twin config (`seedTwin.ts` doesn't read any removed contract).

## Acceptance
- **Unit tests:** `encodeMultiPublish` output has selector `0x2a29fadc` and decodes with the extension ABI; each `publishIndex` equals the target's position; both encoders throw on an unknown, empty or duplicate localId, naming it.
- **Against the twin** (seed-protocol `main`): `bun run twin:up`, then `bun run twin:e2e --sdk <path to your branch>`. All checks pass, including:
  - interactive publish with a cross-reference (fails on 0.6.8);
  - "the SDK's encoder refuses a cross-reference to a localId that isn't in the batch" (the error must name `no-such-request`);
  - the pre-send check rejecting a batch the contract refuses (`PUBLISH_PREFLIGHT_FAILED` naming `PropertyToUpdateNotFound`).
- **Release** (0.6.9 or whatever's next) and tell us the version; we then redeploy and switch the router (steps 9.1–9.3).

## New addresses (after our deploy)
Predicted, all CREATE2 from the Seed deployer; confirmed when deployed:

| Contract | OP Sepolia |
|---|---|
| `SeedProtocolExtension` | `0xde5F3133D9A4a4957ad44b4C8d44D0cfaf0A4A6B` |
| `SeedProtocolExecutor` | `0xC8FF756ED1fC96C604FBFc356B1379262411338B` |
| `SeedExecutorRouterExtension` | `0x24E7e7EAa628d1A448B720728bc2daF3255F5D6D` |

The SDK doesn't hardcode any of them; the executor address goes into config after step 9.7. Contracts deployed earlier on 2026-10-03 (`0x7AaC…`, `0x2ee2…`, `0xF245…`, `0x8eAe…`) are superseded and won't be routed.
