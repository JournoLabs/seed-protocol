# Plan: local sandbox with Blockscout

Goal: one command brings up a local chain with EAS, the Seed contracts and the thirdweb account stack, several funded test accounts, and a local Blockscout, so `multiPublish` (and its failure cases) can be exercised by hand through the explorer UI.

This builds on the deploy plan's local rehearsal ([deploy-plan.md](deploy-plan.md), step 6). `rehearse:local` already starts a `hardhat node`, deploys `LocalStack`, deploys `SeedProtocol` with create2, runs the rollout and publishes. The sandbox keeps that running, adds accounts and schemas a human can use, and puts Blockscout in front of it.

## 1. What the sandbox gives you

After `bun run sandbox:up`:

- **Chain:** a `hardhat node` on `http://127.0.0.1:8545`, chain id 31337.
- **Contracts, verified in Blockscout:** EAS + SchemaRegistry, EntryPoint, ManagedAccountFactory with AccountExtension, the Seed contracts from `ignition/modules/SeedProtocol.ts`, routed by `seed:replace-extension` exactly as on OP Sepolia.
- **Schemas:** a fixed set registered on the local SchemaRegistry (seed, version, property; see I3).
- **Test accounts** (Hardhat's well-known keys, each with 10,000 ETH):

  | Role | EOA | Smart account | Set up as |
  |------|-----|---------------|-----------|
  | factory admin | #0 | — | holds `EXTENSION_ROLE` |
  | alice | #1 | alice's account, 1 ETH | admin of her account; has granted a session key to `delegate` (`approvedTargets = [account]`) |
  | bob | #2 | bob's account, 1 ETH | admin of his account; has run `installSeedExecutor` |
  | delegate | #3 | — | session key on alice's account |
  | stranger | #4 | — | no permissions |
  | bundler | #5 | — | submits UserOps |

- **Blockscout** on `http://localhost` (or another port), indexing the chain.
- **A cheat sheet** (`sandbox/out/sandbox.json`, also printed): every address, private key, schema UID, and ready-to-paste `multiPublish` arguments (with the `data` fields already ABI-encoded, since Blockscout's form takes raw `bytes`).

Manual checks this enables, through Blockscout's Write tab with MetaMask:

| As | Call | Expected |
|----|------|----------|
| alice | `multiPublish` on alice's account | succeeds; 3 `Attested` events with attester = alice's account |
| stranger | same | reverts `Unauthorized(stranger)` |
| delegate | same, sent directly rather than as a UserOp | reverts `Unauthorized(delegate)` |
| alice | `execute(EAS, 0, revoke(...))` on her account | revokes one of her attestations |
| anyone | `setEas` on an account | not routed (reverts) |

The session-key and executor paths need a signed UserOp, which Blockscout's form can't produce. `sandbox:publish` (today's `seed:publish-smoke`) sends those, and the resulting transactions are then inspectable in Blockscout, user ops included if the user-ops indexer is enabled (step 5).

## 2. The hard part: showing `multiPublish` on an account

A thirdweb account is an EIP-1167 clone of `ManagedAccount`, and `multiPublish`, `execute` and the rest are **routed** through the factory, not part of `ManagedAccount`'s ABI. Blockscout's proxy detection covers EIP-1167, 1967, 1822, 2535, 7702 and a few others, but not thirdweb's Router (ERC-7504). So out of the box, an account's "Write as proxy" tab shows `ManagedAccount`'s own functions only, without `multiPublish`.

Options, to be settled by the spike (step 1):

- **A. Local-only diamond loupe.** Blockscout detects EIP-2535 diamonds by `eth_call`ing `facetAddresses()` (`0x52ef6b2c`), and then offers the ABIs of the returned (verified) contracts. A tiny `SandboxLoupeExtension` registered on the **local** factory only could answer `facetAddresses()` with the AccountExtension, SeedProtocolExtension and SeedExecutorRouterExtension implementations. Every account would then show `multiPublish`, `execute` and friends, called directly on the account, so the real access control runs.
  - Unknown: whether Blockscout tries EIP-2535 on an address whose bytecode already matches EIP-1167. If the bytecode match wins, this doesn't work.
  - Cost: one small contract, local factory only. It must never be registered on a real factory. It also makes the local registry differ from OP Sepolia by one extension, which `seed:replace-extension` already tolerates.
- **B. Blockscout "Custom ABI".** Documented and works on any address, but it needs Blockscout's My Account feature. That means an Auth0 tenant (free dev tier), Redis and a cloak key in the sandbox config, plus logging in. It works, but it's the heaviest setup and puts third-party auth into a local tool.
- **C. Fallback: Blockscout for reading, a small local page for writing.** A single static page (ethers + MetaMask) prefilled from the cheat sheet calls `multiPublish` on a chosen account. Blockscout then shows the decoded transaction, events and attestations. Least setup, but the write doesn't happen "in Blockscout".

Recommendation: try A in the spike; if Blockscout won't treat a clone as a diamond, choose between B and C (your call, I1).

## 3. Decisions

### S1: `hardhat node`, reset on every `up`
- The rehearsal tooling already works against it, with deterministic LocalStack addresses.
- It's in-memory, so stopping it loses the chain. To keep Blockscout from showing a stale chain, `sandbox:up` always starts from scratch: it wipes Blockscout's database volumes and redeploys. Addresses come out the same every time, so bookmarks and MetaMask setups keep working.
- **Alternative:** Anvil with `--state` would let a session survive restarts, and Blockscout ships an `anvil.yml`. It adds Foundry as a dependency and means checking our tasks against Anvil (`isSimulated` needs to recognise it; Ignition's CreateX bootstrap and impersonation use `hardhat_*` RPCs, which Anvil aliases). Worth it only if persistence matters (I2).

### S2: Blockscout via its own Docker Compose files, pinned
- Upstream's `docker-compose/hardhat-network.yml` already targets a Hardhat node at `host.docker.internal:8545`, chain 31337 (`ETHEREUM_JSONRPC_VARIANT=geth`, opcode tracer).
- Vendor a trimmed copy into `sandbox/blockscout/` with image tags pinned, rather than cloning Blockscout at run time.
- Keep: db, redis, backend, frontend, nginx proxy, sig-provider. Optional: user-ops-indexer (step 5). Drop: stats, visualizer.

### S3: Verify everything in Blockscout
Decoded calls, events and errors depend on it. Use `hardhat-verify`'s Blockscout support with a custom chain entry for the local instance. The thirdweb and EAS sources come from Hardhat's build info, so the `patches/` remapping is already baked in.

### S4: The sandbox only uses the real rollout commands
Same as the rehearsals: Ignition deploy, `seed:replace-extension`, `seed:verify-live`. Sandbox-only setup (accounts, schemas, session key, executor install, loupe) goes in its own script. That way the sandbox also re-proves the rollout every time it starts.

## 4. Work breakdown

1. **Spike (time-boxed, about half a day).** Bring up upstream `hardhat-network.yml` against `rehearse:local`'s node, held open. Answer:
   - Does Blockscout index a Hardhat 3 (EDR) node, internal transactions included? The opcode tracer needs `debug_traceTransaction`.
   - Does the frontend's wallet connection work locally? The current frontend uses Reown AppKit and may need a (free) `NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID`; if so, that's input I4.
   - Does `hardhat verify` against the local Blockscout work for our contracts and the thirdweb ones?
   - Option A: register a throwaway loupe extension and see whether an account's Write tab shows `multiPublish`.
   - How does Blockscout's form handle `multiPublish`'s nested `tuple[]` input? If it's unusable, the cheat sheet needs a different shape, or option C becomes the main path.

   Record the findings here, then confirm the option (A/B/C) before step 2.
2. **Sandbox setup script** (`scripts/sandbox_setup.ts`, a `seed:sandbox-setup` task). After the rollout: register schemas, create and fund alice's and bob's accounts, grant `delegate` a session key on alice's account, run `installSeedExecutor` for bob, then write `sandbox/out/sandbox.json` and print it. Reuses `scripts/lib/managedAccount.ts`. With option A, also deploy and register `SandboxLoupeExtension` (in `contracts/sandbox/`, kept out of the production module).
3. **Blockscout config** in `sandbox/blockscout/`: pinned Compose files and env, wired to the host node; plus the `verify` config for the local Blockscout in `hardhat.config.ts`.
4. **Orchestration** in `scripts/rehearse.ts` (or a sibling `scripts/sandbox.ts`):
   - `bun run sandbox:up`: check Docker and port 8545 are free; wipe Blockscout volumes; start the node; run the local rollout (as `rehearse:local` does); run `sandbox-setup`; verify contracts; start Blockscout; wait until it has indexed the head block; print the cheat sheet and the Blockscout URL. The node keeps running in the foreground (Ctrl-C stops everything).
   - `bun run sandbox:down`: stop Blockscout and the node.
   - `bun run sandbox:publish`: the UserOp paths (`seed:publish-smoke` against alice's and bob's accounts).
5. **Optional: user-ops indexer.** Point Blockscout's user-ops-indexer at the local EntryPoint v0.6, so session-key publishes show up as user operations. Only if the spike shows it's cheap.
6. **Docs:** a "Local sandbox" section in the README covering:
   - prerequisites;
   - MetaMask setup (custom network 31337, importing the test keys);
   - a walkthrough of each manual check in §1;
   - troubleshooting: ports, stale volumes, MetaMask nonce reset after `up`.

## 5. Inputs needed

| ID | Input | Needed by |
|----|-------|-----------|
| I1 | Which write path if option A fails: B (Auth0 + Custom ABI in Blockscout) or C (local write page)? | after step 1 |
| I2 | Does the sandbox need to survive restarts (→ Anvil with `--state`), or is a fresh deterministic chain per `up` fine? | step 1 |
| I3 | Which schemas to register: the minimal test set (`bytes32 post`, `bytes32 version`, `string value`, …), or the SDK's real Seed schema strings, so payloads look like production? If the latter, point me at them in `seed-protocol-sdk`. | step 2 |
| I4 | A Reown (WalletConnect) project id, if the spike shows Blockscout's wallet connection needs one | step 3 |

## 6. Prerequisites and risks

- **Docker** (Docker Desktop on macOS), with roughly 4 GB of memory for Blockscout's services. Port 80 (or whichever we choose) and 8545 free.
- **MetaMask** with the Hardhat test keys imported. They're public; never send real funds to them. After each `up` the chain restarts at nonce 0, so MetaMask needs "Clear activity tab data" for those accounts.
- **Blockscout + Hardhat 3 compatibility** is the main unknown (tracing, `eth_getBlockReceipts`-style batch calls); the spike settles it. Anvil is the fallback node (S1).
- **Option A is a hack around Blockscout**, contained to the local factory. If it works, document it clearly as sandbox-only, so nobody copies it to a real factory.
- **Blockscout's form and nested structs:** `multiPublish` takes arrays of structs containing arrays of structs. If entering that by hand is painful, the cheat sheet's prefilled payloads, or option C, carry the manual tests.
