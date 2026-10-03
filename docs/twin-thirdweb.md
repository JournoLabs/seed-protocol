# Using thirdweb against the local twin

For developers of seed-protocol-sdk and permapress who are pointing them at `bun run twin:up` (see [local-twin-plan.md](local-twin-plan.md)). Everything here was checked against thirdweb 5.121.4, the version the SDK uses.

**Short version:** yes, the connect button and in-app wallets work against the twin, with login exactly as in production. Use **EIP-4337 smart accounts with our local bundler and no sponsored gas**. thirdweb's **EIP-7702 mode doesn't work locally**, because it depends on thirdweb's hosted services for the chain.

## 1. Read the twin's settings from `.twin/twin.json`

`twin:up` writes `chainId` (31337), `rpcUrl`, `bundlerUrl`, `easGraphqlUrl`, `entryPoint`, every contract address (including `managedAccountFactory`), the base schema UIDs and some funded test accounts.

```ts
import { defineChain } from "thirdweb";

export const twinChain = defineChain({
  id: 31337,
  rpc: twin.rpcUrl, // http://127.0.0.1:8545
  name: "Seed twin (OP Sepolia fork)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  testnet: true,
});
```

## 2. The connect button and in-app wallet

```tsx
const wallet = inAppWallet({
  auth: { options: ["email", "passkey", "phone", "farcaster"] },
  executionMode: {
    mode: "EIP4337",
    smartAccount: {
      chain: twinChain,
      factoryAddress: twin.contracts.managedAccountFactory, // same address as production
      sponsorGas: false, // no paymaster on the twin (see §4)
      overrides: { bundlerUrl: twin.bundlerUrl }, // http://127.0.0.1:4337
    },
  },
});

<ConnectButton client={client} wallets={[wallet]} chain={twinChain} chains={[twinChain]} />
```

- **Login stays hosted, and that's fine.** Email, passkey, phone and Farcaster login go through thirdweb's auth service, which doesn't depend on the chain. You need the internet, and the client id must allow your local origin (e.g. `local.app.permapress.xyz`), as it already does for local development.
- **You get your real accounts.** Login gives the same in-app EOA as production. The twin is a fork of OP Sepolia with the same factory, so your smart account address is your real one, with your real pre-fork data on the chain and in the twin's indexer. Nothing you do on the twin reaches OP Sepolia.
- **Verified path.** A thirdweb smart wallet with `overrides.bundlerUrl` set to the twin's bundler deploys the account and publishes through it (spike, plan §8). With a non-thirdweb bundler URL, thirdweb uses only standard ERC-4337 RPCs and takes gas prices from the node. The in-app wallet's `EIP4337` mode passes `smartAccount` straight to the same smart-wallet code.
- **Expect some connect-button extras not to work.** Buy funds, fiat on-ramp, token prices and chain icons come from thirdweb services that don't know chain 31337. Turn them off or ignore them locally.

## 3. Execution modes on the twin

| Mode | Works on the twin? | Notes |
|------|-------------------|-------|
| `EIP4337` smart account (ManagedAccount), `sponsorGas: false`, `bundlerUrl` override | **Yes** | The production account type. Fund the account first (§4). |
| `EIP4337` with `sponsorGas: true` | No | Uses thirdweb's hosted paymaster, which doesn't serve 31337. |
| `EIP7702`, `sponsorGas: true` | No | Sends to thirdweb's hosted executor (`tw_execute`). |
| `EIP7702`, `sponsorGas: false` | No | Still looks up the delegation contract on thirdweb's hosted bundler (`tw_getDelegationContract`), using the default URL for the chain; no override is passed. That endpoint answers `Invalid chain: 31337`. |
| In-app wallet with no execution mode (plain EOA) | Yes | Pays its own gas; fund it. Not the production account type. |
| MetaMask or other external wallet | Yes | Add a custom network (chain id 31337, RPC `http://127.0.0.1:8545`) and fund the address. |

**permapress currently defaults to `EIP7702` with `sponsorGas`** (the SDK's modular wallet). On the twin, run the 4337 path instead. thirdweb's sponsored 7702 path can only be tested on the real OP Sepolia: make that a step in the release checklist.

## 4. Gas: fund accounts yourself

The twin has no paymaster, so whatever sends transactions needs ETH:
- a smart account pays for its own UserOps. Without ETH you get `AA21 didn't pay prefund`;
- an EOA pays for its own transactions.

```bash
bun run twin:fund 0xYourSmartAccount 0xYourEoa --eth 10
```

Run this in the seed-protocol repo while the twin is up. It works on a smart account's address before the account is deployed. The test accounts in `twin.json` already have 100 ETH each.

## 5. Things that will bite

- **A leftover `optimismSepolia` is the dangerous bug.** Any code that still uses thirdweb's `optimismSepolia` chain object talks to the **real** OP Sepolia through thirdweb's RPC. Reads come back with real-chain data, and a write would be signed for and sent to the real testnet. Every chain object has to come from your network config. That's the point of the SDK's network-config work.
- **Chain id 31337 on purpose.** A transaction or service call that misses the local config fails, instead of being valid on OP Sepolia.
- **Every `twin:up` resets the chain to the fork block.** Accounts, attestations and nonces from the previous session are gone. Clear what apps cached between runs: the SDK's local database and browser storage for the app origin. In MetaMask, use "Clear activity tab data" for the twin network, or it'll reuse old nonces.
- **Nonces on the fork.** ethers' pending-nonce lookup lags one block behind on the twin, so back-to-back sends from one wallet can fail with "nonce too low". Keep this in mind if you see it in viem or ethers code paths; `NonceManager` fixes it for ethers.
- **Reads go to the twin's indexer:** point the EAS GraphQL endpoint at `twin.easGraphqlUrl` (`http://localhost:4000/graphql`). It's the official EAS indexer, with the same schema as easscan.
- **Uploads go to the local gateway:** run `../seed-protocol-server` alongside.
- **"UserOp failed at txHash: 0x…" with no reason** usually means the UserOp ran out of gas: thirdweb only has a reason when the EntryPoint logged one. Run `npx hardhat seed:explain-userop --network localhost --tx 0x…` here: it decodes the revert, or replays the call and says how much gas it needed. With `--network optimism_sepolia` it reads OP Sepolia instead (it needs that network's usual `.env` settings; tested on the twin only so far).
