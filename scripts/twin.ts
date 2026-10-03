/**
 * `bun run twin:up`: a local OP Sepolia twin for end-to-end development
 * (docs/local-twin-plan.md). Runs in the foreground; Ctrl-C stops everything.
 *
 *   1. A hardhat node forking OP Sepolia at a pinned block, under chain id 31337 (T1).
 *   2. The rollout, with the same commands as the real one, then seed:ensure-schemas and
 *      seed:verify-live.
 *   3. Funded test accounts (fresh keys, kept in .twin/keys.json across runs).
 *   4. A local ERC-4337 bundler (alto) on the fork's EntryPoint v0.6.
 *   5. Smoke tests: the contract paths (seed:publish-smoke) and a UserOp through the bundler.
 *   6. The official EAS indexer (infra/eas-indexer, Docker), seeded with OP Sepolia's
 *      pre-fork schemas, schema names and attestations from easscan (cached per fork block).
 *   7. .twin/twin.json: endpoints, addresses, schemas and accounts, for the SDK and apps.
 *
 * Options:
 *   --fork-block <number|latest>  default: the pinned TWIN_FORK_BLOCK below
 *   --light-index                 seed the indexer with schemas and names only, no attestations
 *   --no-indexer                  skip the indexer (no Docker needed)
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Contract, Interface, JsonRpcProvider, NonceManager, Wallet, ZeroAddress, ZeroHash, parseEther, toQuantity } from "ethers";
import { sendUserOpViaBundler } from "./lib/bundler.js";
import {
  dockerAvailable,
  graphql,
  insertSeedData,
  loadSeedData,
  startIndexer,
  stopIndexer,
  tablesExist,
  waitForGraphql,
} from "./lib/easIndexer.js";
import { buildPublishRequests } from "./lib/managedAccount.js";
import { ROOT, RPC, deployedAddresses, firstAccount, hardhat, rpc, rpcUp, spawnLogged, startNode, waitForRpc } from "./lib/orchestration.js";
import { BASE_SCHEMAS, schemaUid } from "./lib/schemas.js";

/** OP Sepolia block the twin forks by default. Pinned, so every `up` starts from the same state. */
const TWIN_FORK_BLOCK = 49_590_000;
const BUNDLER_PORT = 4337;
const BUNDLER_URL = `http://127.0.0.1:${BUNDLER_PORT}`;
const INDEXER_GRAPHQL_URL = "http://localhost:4000/graphql";
const ENTRY_POINT_V06 = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789";
const DEPLOYMENT_ID = "twin";
const PARAMETERS = "ignition/parameters/optimism_sepolia.json";
const STATE_DIR = path.join(ROOT, ".twin");
const ACCOUNT_NAMES = ["alice", "bob", "carol", "dave", "erin"];

interface Keys {
  bundlerExecutor: string;
  bundlerUtility: string;
  accounts: { name: string; privateKey: string }[];
}

/**
 * Fresh keys, created once per checkout. Hardhat's well-known keys have real history on
 * OP Sepolia, which the fork inherits (nonces in the thousands), so the twin never uses them.
 */
function loadKeys(): Keys {
  const file = path.join(STATE_DIR, "keys.json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const keys: Keys = {
    bundlerExecutor: Wallet.createRandom().privateKey,
    bundlerUtility: Wallet.createRandom().privateKey,
    accounts: ACCOUNT_NAMES.map((name) => ({ name, privateKey: Wallet.createRandom().privateKey })),
  };
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(keys, null, 2) + "\n");
  return keys;
}

async function forkBlock(arg: string | undefined): Promise<string> {
  if (!arg) return String(TWIN_FORK_BLOCK);
  if (arg !== "latest") return String(Number(arg));
  const url = process.env.OPTIMISM_SEPOLIA_RPC_URL;
  if (!url) throw new Error("--fork-block latest needs OPTIMISM_SEPOLIA_RPC_URL");
  return String(await new JsonRpcProvider(url).getBlockNumber());
}

function artifactAbi(file: string) {
  return new Interface(JSON.parse(readFileSync(path.join(ROOT, "artifacts", file), "utf8")).abi);
}

async function up(args: string[]) {
  const option = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? undefined : args[i + 1];
  };
  const block = await forkBlock(option("fork-block"));
  const withIndexer = !args.includes("--no-indexer");
  const lightIndex = args.includes("--light-index");
  if (withIndexer && !dockerAvailable()) throw new Error("The EAS indexer needs Docker running (or pass --no-indexer).");
  const keys = loadKeys();
  if (await rpcUp(BUNDLER_URL)) throw new Error(`Something is already listening on ${BUNDLER_URL}; stop it first.`);
  rmSync(path.join(ROOT, "ignition/deployments", DEPLOYMENT_ID), { recursive: true, force: true });

  const children = [await startNode(["--network", "op_sepolia_twin"], { log: "twin-node.log", env: { TWIN_FORK_BLOCK: block } })];
  let indexerStarted = false;
  const stop = () => {
    for (const child of children) child.kill();
    if (indexerStarted) stopIndexer();
  };
  process.on("SIGINT", () => {
    console.log("\nStopping the twin.");
    stop();
    process.exit(0);
  });

  try {
    // 2. The rollout, as on the real chain.
    const parameters = JSON.parse(readFileSync(path.join(ROOT, PARAMETERS), "utf8"));
    const factoryAddress: string = parameters.SeedRollout.factory;
    const common = ["--network", "localhost", "--parameters", PARAMETERS];
    hardhat("ignition", "deploy", "ignition/modules/SeedProtocol.ts", "--network", "localhost",
      "--deployment-id", DEPLOYMENT_ID, "--strategy", "create2", "--parameters", PARAMETERS);
    hardhat("seed:replace-extension", ...common, "--deployment-id", DEPLOYMENT_ID, "--impersonate", "auto");
    hardhat("seed:ensure-schemas", ...common);
    hardhat("seed:verify-live", ...common, "--deployment-id", DEPLOYMENT_ID, "--account", await firstAccount(factoryAddress));

    // 3. Funds.
    const provider = new JsonRpcProvider(RPC);
    const accounts = keys.accounts.map((a) => ({ name: a.name, wallet: new Wallet(a.privateKey, provider) }));
    const bundlerWallets = [keys.bundlerExecutor, keys.bundlerUtility].map((k) => new Wallet(k));
    for (const { wallet } of accounts) await rpc("hardhat_setBalance", [wallet.address, toQuantity(parseEther("100"))]);
    for (const wallet of bundlerWallets) await rpc("hardhat_setBalance", [wallet.address, toQuantity(parseEther("1000"))]);

    // 4. The bundler. --max-block-range keeps its log queries after the fork block; earlier
    //    ranges are forwarded to the upstream RPC, which may refuse them (Alchemy free tier).
    const bundler = spawnLogged(path.join(ROOT, "node_modules/.bin/alto"), [
      "--rpc-url", RPC,
      "--entrypoints", ENTRY_POINT_V06,
      "--executor-private-keys", keys.bundlerExecutor,
      "--utility-private-key", keys.bundlerUtility,
      "--chain-type", "op-stack",
      "--safe-mode", "false",
      "--max-block-range", "5",
      "--port", String(BUNDLER_PORT),
    ], "twin-bundler.log");
    children.push(bundler.child);
    console.log(`\nStarting the bundler (log: ${bundler.logFile})`);
    await waitForRpc(BUNDLER_URL, bundler.child, "alto", bundler.logFile);

    // 5. Smoke tests: contract paths, then the bundler path the SDK uses.
    hardhat("seed:publish-smoke", "--network", "localhost", "--parameters", PARAMETERS);

    const seed = deployedAddresses(DEPLOYMENT_ID);
    const alice = accounts[0].wallet;
    const registry = new Contract(parameters.SeedProtocol.eas, ["function getSchemaRegistry() view returns (address)"], provider);
    const schemaRegistry = new Contract(await registry.getSchemaRegistry(), artifactAbi(
      "@ethereum-attestation-service/eas-contracts/contracts/SchemaRegistry.sol/SchemaRegistry.json"),
      // On the fork, ethers' pending-nonce lookup lags a block behind, so back-to-back
      // sends from one wallet collide; NonceManager counts locally.
      new NonceManager(alice));
    const smokeSchemas = { seed: "bytes32 twin_smoke_post", property: "string twin_smoke_title" };
    for (const s of Object.values(smokeSchemas)) {
      if ((await schemaRegistry.getSchema(schemaUid(s))).uid === ZeroHash) await (await schemaRegistry.register(s, ZeroAddress, true)).wait();
    }
    const extension = artifactAbi("contracts/SeedProtocolExtension.sol/SeedProtocolExtension.json");
    const accountAbi = artifactAbi("@thirdweb-dev/contracts/prebuilts/account/utils/AccountExtension.sol/AccountExtension.json");
    const publish = extension.encodeFunctionData("multiPublish", [
      buildPublishRequests({
        seedSchemaUid: schemaUid(smokeSchemas.seed),
        versionSchemaUid: BASE_SCHEMAS.find((s) => s.key === "version")!.uid,
        propertySchemaUid: schemaUid(smokeSchemas.property),
      }),
    ]);
    console.log("\nUserOp through the bundler: alice's ManagedAccount → execute(account, multiPublish)");
    const factory = new Contract(factoryAddress, artifactAbi(
      "@thirdweb-dev/contracts/prebuilts/account/managed/ManagedAccountFactory.sol/ManagedAccountFactory.json"), provider);
    // No paymaster on the twin (T2): the account prefunds its own UserOps.
    const aliceAccount: string = await factory.getFunction("getAddress")(alice.address, "0x");
    await rpc("hardhat_setBalance", [aliceAccount, toQuantity(parseEther("10"))]);
    const userOp = await sendUserOpViaBundler({
      bundlerUrl: BUNDLER_URL,
      provider,
      entryPoint: new Contract(ENTRY_POINT_V06, artifactAbi(
        "@thirdweb-dev/contracts/prebuilts/account/utils/Entrypoint.sol/EntryPoint.json"), provider),
      factory,
      admin: alice,
      callData: (sender) => accountAbi.encodeFunctionData("execute", [sender, 0n, publish]),
    });
    if (!userOp.success) throw new Error(`Bundler smoke UserOp failed (tx ${userOp.transactionHash})`);
    console.log(`ok    UserOp ${userOp.userOpHash} included in ${userOp.transactionHash}`);

    // 6. The EAS indexer, from the block after the fork, seeded with what came before it.
    if (withIndexer) {
      const forkTimestamp = Number((await provider.getBlock(Number(block)))!.timestamp);
      console.log(`\nLoading the indexer seed (OP Sepolia up to block ${block}${lightIndex ? ", schemas and names only" : ""})…`);
      const seedData = await loadSeedData(Number(block), forkTimestamp, { light: lightIndex });
      console.log(`Starting the EAS indexer (infra/eas-indexer)…`);
      indexerStarted = true;
      startIndexer({
        chainId: 31337,
        eas: parameters.SeedProtocol.eas,
        schemaRegistry: String(schemaRegistry.target),
        startBlock: Number(block) + 1,
        rpcUrl: "http://host.docker.internal:8545",
      });
      // The indexer creates its tables on start. Until the seed lands, it retries any batch
      // that uses a pre-fork schema; the next poll after seeding goes through.
      for (let i = 0; !tablesExist(); i++) {
        if (i > 180) throw new Error("The EAS indexer never created its tables");
        await new Promise((r) => setTimeout(r, 1000));
      }
      insertSeedData(seedData);
      await waitForGraphql(INDEXER_GRAPHQL_URL);
      for (let i = 0; ; i++) {
        const { attestations } = await graphql(INDEXER_GRAPHQL_URL,
          `query($a: String) { attestations(where: { attester: { equals: $a } }) { id } }`, { a: userOp.sender });
        if (attestations.length >= 3) break;
        if (i > 60) throw new Error("The EAS indexer didn't index the smoke attestations within a minute");
        await new Promise((r) => setTimeout(r, 1000));
      }
      console.log(`ok    EAS indexer at ${INDEXER_GRAPHQL_URL}: ${seedData.schemas.length} schemas, ` +
        `${seedData.schemaNames.length} names${seedData.attestations ? `, ${seedData.attestations.length} attestations` : ""} seeded; smoke attestations indexed`);
    }

    // 7. What the SDK and apps need.
    const twin = {
      chainId: 31337,
      rpcUrl: RPC,
      bundlerUrl: BUNDLER_URL,
      easGraphqlUrl: withIndexer ? INDEXER_GRAPHQL_URL : null,
      forkedFrom: { chain: "optimism-sepolia", chainId: 11155420, block: Number(block) },
      entryPoint: ENTRY_POINT_V06,
      contracts: {
        eas: parameters.SeedProtocol.eas,
        schemaRegistry: schemaRegistry.target,
        managedAccountFactory: factoryAddress,
        seedProtocolExtension: seed["SeedProtocol#SeedProtocolExtension"],
        seedProtocolExtensionV2: seed["SeedProtocol#SeedProtocolExtensionV2"],
        seedProtocolExecutor: seed["SeedProtocol#SeedProtocolExecutor"],
        seedExecutorRouterExtension: seed["SeedProtocol#SeedExecutorRouterExtension"],
      },
      baseSchemas: Object.fromEntries(BASE_SCHEMAS.map((s) => [s.key, s.uid])),
      accounts: accounts.map(({ name, wallet }) => ({ name, address: wallet.address, privateKey: wallet.privateKey })),
      // Deployed by the smoke UserOp, with 10 ETH for its own gas.
      aliceManagedAccount: userOp.sender,
    };
    writeFileSync(path.join(STATE_DIR, "twin.json"), JSON.stringify(twin, null, 2) + "\n");

    console.log(`
Twin is up (OP Sepolia @ ${block}, chain id 31337). Ctrl-C to stop.

  RPC        ${RPC}
  Bundler    ${BUNDLER_URL}   (EntryPoint v0.6 ${ENTRY_POINT_V06})
  EAS index  ${withIndexer ? `${INDEXER_GRAPHQL_URL}   (official eas-indexing-service)` : "not started (--no-indexer)"}
  Factory    ${factoryAddress}
  EAS        ${twin.contracts.eas}
  Accounts   ${accounts.map(({ name, wallet }) => `${name} ${wallet.address}`).join("\n             ")}
             (100 ETH each; keys in .twin/keys.json)

Everything above, for the SDK and apps: .twin/twin.json
Not started here: the seed gateway (run ../seed-protocol-server alongside).`);
  } catch (e) {
    stop();
    throw e;
  }
  await new Promise(() => {}); // Run until Ctrl-C.
}

const [command, ...rest] = process.argv.slice(2);
if (command === "up") {
  await up(rest);
} else {
  console.error("usage: bun scripts/twin.ts up [--fork-block <number|latest>] [--light-index | --no-indexer]");
  process.exit(2);
}
