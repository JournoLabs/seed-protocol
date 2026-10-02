const { ethers } = require("hardhat");
const { deployEASWithSchemas } = require("./easFixture");

/**
 * Real thirdweb ManagedAccount stack for exercising Seed extensions the way they
 * run on-chain: account fallback → Router → delegatecall into the extension.
 *
 * The older fixtures call the extension contract directly, which can't observe
 * delegatecall context (msg.sender, account storage, admin checks). Use this one
 * for anything that touches access control.
 */

const MAX_UINT128 = (1n << 128n) - 1n;
const ONE_DAY = 24n * 60n * 60n;

/** Mirrors how SeedProtocolExtension is registered on OP Sepolia today (scripts/get_extension_json.ts). */
const SEED_EXTENSION_CURRENT = {
  name: "SeedProtocolExtension",
  contractName: "SeedProtocolExtension",
  constructorArgs: () => [],
  functions: ["multiPublish", "setEas", "getEas"],
};

const SIGNER_PERMISSION_TYPES = {
  SignerPermissionRequest: [
    { name: "signer", type: "address" },
    { name: "isAdmin", type: "uint8" },
    { name: "approvedTargets", type: "address[]" },
    { name: "nativeTokenLimitPerTransaction", type: "uint256" },
    { name: "permissionStartTimestamp", type: "uint128" },
    { name: "permissionEndTimestamp", type: "uint128" },
    { name: "reqValidityStartTimestamp", type: "uint128" },
    { name: "reqValidityEndTimestamp", type: "uint128" },
    { name: "uid", type: "bytes32" },
  ],
};

// ---------------------------------------------------------------------------
// Router helpers
// ---------------------------------------------------------------------------

/**
 * Builds the `Extension` struct the thirdweb Router expects. Selectors are derived
 * from the canonical signature, which is what BaseRouter validates against.
 */
function buildExtension(name, implementation, iface, functionNames) {
  return {
    metadata: { name, metadataURI: "", implementation },
    functions: functionNames.map((fnName) => {
      const fragment = iface.getFunction(fnName);
      if (!fragment) throw new Error(`${name}: no function ${fnName}`);
      return { functionSelector: fragment.selector, functionSignature: fragment.format("sighash") };
    }),
  };
}

/** All function names in an interface (used to route the whole AccountExtension). */
function allFunctionNames(iface) {
  return iface.fragments.filter((f) => f.type === "function").map((f) => f.format("sighash"));
}

/** Merges ABIs into one Interface, dropping duplicates (account + routed extensions share some). */
function mergeInterfaces(...ifaces) {
  const seen = new Set();
  const fragments = [];
  for (const iface of ifaces) {
    for (const fragment of iface.fragments) {
      if (!["function", "event", "error"].includes(fragment.type)) continue;
      const key = `${fragment.type}:${fragment.format("sighash")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fragments.push(fragment);
    }
  }
  return new ethers.Interface(fragments);
}

// ---------------------------------------------------------------------------
// Session keys
// ---------------------------------------------------------------------------

async function latestTimestamp() {
  return BigInt((await ethers.provider.getBlock("latest")).timestamp);
}

/**
 * Signs and submits a SignerPermissionRequest. `admin` must be an account admin;
 * the request can be submitted by anyone, matching thirdweb's design.
 */
async function setSignerPermissions(account, admin, request) {
  const { chainId } = await ethers.provider.getNetwork();
  const domain = { name: "Account", version: "1", chainId, verifyingContract: await account.getAddress() };
  const fullRequest = {
    isAdmin: 0,
    approvedTargets: [],
    nativeTokenLimitPerTransaction: 0n,
    permissionStartTimestamp: 0n,
    permissionEndTimestamp: 0n,
    reqValidityStartTimestamp: 0n,
    reqValidityEndTimestamp: MAX_UINT128,
    uid: ethers.hexlify(ethers.randomBytes(32)),
    ...request,
  };
  const signature = await admin.signTypedData(domain, SIGNER_PERMISSION_TYPES, fullRequest);
  const tx = await account.connect(admin).setPermissionsForSigner(fullRequest, signature);
  return tx.wait();
}

/** Grants a non-admin session key (e.g. a third-party publisher) scoped to `approvedTargets`. */
async function grantSessionKey(account, admin, signerAddress, { approvedTargets, nativeTokenLimit = 0n, duration = ONE_DAY }) {
  const now = await latestTimestamp();
  return setSignerPermissions(account, admin, {
    signer: signerAddress,
    approvedTargets,
    nativeTokenLimitPerTransaction: nativeTokenLimit,
    permissionStartTimestamp: now - 1n,
    permissionEndTimestamp: now + duration,
  });
}

/** Revokes a session key: no targets and an expired window, so `isValidSigner` rejects it. */
async function revokeSessionKey(account, admin, signerAddress) {
  return setSignerPermissions(account, admin, { signer: signerAddress });
}

// ---------------------------------------------------------------------------
// ERC-4337 UserOperations (EntryPoint v0.6)
// ---------------------------------------------------------------------------

/**
 * Signs `callData` as a UserOperation from `signer` and submits it via handleOps.
 * Validation failures make handleOps revert with `FailedOp`; execution failures
 * don't revert, so the result reports `success` and any `revertReason`.
 */
async function sendUserOp({ entryPoint, account, signer, callData, bundler }) {
  const sender = await account.getAddress();
  const block = await ethers.provider.getBlock("latest");
  const priorityFee = ethers.parseUnits("1", "gwei");

  const op = {
    sender,
    nonce: await entryPoint.getNonce(sender, 0),
    initCode: "0x",
    callData,
    callGasLimit: 5_000_000n,
    verificationGasLimit: 1_000_000n,
    preVerificationGas: 100_000n,
    maxFeePerGas: block.baseFeePerGas * 2n + priorityFee,
    maxPriorityFeePerGas: priorityFee,
    paymasterAndData: "0x",
    signature: "0x",
  };
  op.signature = await signer.signMessage(ethers.getBytes(await entryPoint.getUserOpHash(op)));

  const receipt = await (await entryPoint.connect(bundler).handleOps([op], bundler.address)).wait();

  let success = false;
  let revertReason = null;
  for (const log of receipt.logs) {
    let parsed;
    try {
      parsed = entryPoint.interface.parseLog(log);
    } catch {
      continue;
    }
    if (parsed?.name === "UserOperationEvent") success = parsed.args.success;
    if (parsed?.name === "UserOperationRevertReason") revertReason = parsed.args.revertReason;
  }
  return { receipt, success, revertReason };
}

/**
 * Asserts a UserOperation was rejected during validation with an EntryPoint
 * `FailedOp` whose reason starts with `reasonPrefix` (e.g. "AA24" = bad signature
 * / signer not permitted, "AA22" = expired or not yet valid).
 *
 * Decodes the error manually: the installed hardhat-chai-matchers (v1) can't read
 * custom errors from ethers v6 contracts.
 */
async function expectUserOpRejected(promise, entryPoint, reasonPrefix) {
  let error;
  try {
    await promise;
  } catch (e) {
    error = e;
  }
  if (!error) throw new Error(`expected UserOperation to be rejected with ${reasonPrefix}, but it was accepted`);

  const data = error.data ?? error.error?.data ?? error.info?.error?.data;
  const parsed = data ? entryPoint.interface.parseError(data) : null;
  if (parsed?.name !== "FailedOp") throw error;

  const reason = parsed.args.reason;
  if (!reason.startsWith(reasonPrefix)) {
    throw new Error(`expected FailedOp reason starting with "${reasonPrefix}", got "${reason}"`);
  }
  return reason;
}

// ---------------------------------------------------------------------------
// EAS helpers
// ---------------------------------------------------------------------------

/** Returns `{ uid, attester, recipient, schema }` for every Attested event in a receipt. */
function attestedEvents(eas, receipt) {
  const easAddress = eas.target.toLowerCase();
  return receipt.logs
    .filter((log) => log.address.toLowerCase() === easAddress)
    .map((log) => eas.interface.parseLog(log))
    .filter((parsed) => parsed?.name === "Attested")
    .map((parsed) => ({
      recipient: parsed.args.recipient,
      attester: parsed.args.attester,
      uid: parsed.args.uid,
      schema: parsed.args.schemaUID,
    }));
}

/**
 * One legacy (string localId) publish request: new seed + version, plus one
 * property attestation whose refUID the extension rewrites to the new version.
 */
function buildLegacyPublishRequests(setup, { revocable = true, propertyValue = "hello" } = {}) {
  return [
    {
      localId: "request-1",
      seedUid: ethers.ZeroHash,
      seedSchemaUid: setup.seedSchemaUid,
      versionUid: ethers.ZeroHash,
      versionSchemaUid: setup.versionSchemaUid,
      seedIsRevocable: revocable,
      listOfAttestations: [
        {
          schema: setup.propertySchemaUid,
          data: [
            {
              recipient: ethers.ZeroAddress,
              expirationTime: 0n,
              revocable,
              refUID: ethers.ZeroHash,
              data: ethers.AbiCoder.defaultAbiCoder().encode(["string"], [propertyValue]),
              value: 0n,
            },
          ],
        },
      ],
      propertiesToUpdate: [],
    },
  ];
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/**
 * Deploys EAS, EntryPoint, a ManagedAccountFactory with AccountExtension as its
 * default extension, registers `seedExtension` on the factory, and creates one
 * account owned by `accountAdmin`.
 *
 * Roles:
 *   factoryAdmin – holds EXTENSION_ROLE on the factory
 *   accountAdmin – the account's owner
 *   delegate     – third party a session key is granted to
 *   stranger     – unrelated address with no permissions
 *   bundler      – submits UserOperations
 */
async function deployManagedAccountStack({ seedExtension = SEED_EXTENSION_CURRENT } = {}) {
  const [factoryAdmin, accountAdmin, delegate, stranger, bundler] = await ethers.getSigners();

  const easSetup = await deployEASWithSchemas();
  const easAddress = await easSetup.eas.getAddress();

  const entryPoint = await (await ethers.getContractFactory("EntryPoint")).deploy();
  await entryPoint.waitForDeployment();

  const AccountExtension = await ethers.getContractFactory("AccountExtension");
  const accountExtension = await AccountExtension.deploy();
  await accountExtension.waitForDeployment();

  const ManagedAccountFactory = await ethers.getContractFactory("ManagedAccountFactory");
  const factory = await ManagedAccountFactory.deploy(factoryAdmin.address, await entryPoint.getAddress(), [
    buildExtension(
      "AccountExtension",
      await accountExtension.getAddress(),
      AccountExtension.interface,
      allFunctionNames(AccountExtension.interface),
    ),
  ]);
  await factory.waitForDeployment();

  // Plain (non-proxy) deploy of the Seed extension, registered on the factory.
  const SeedExtension = await ethers.getContractFactory(seedExtension.contractName);
  const seedImpl = await SeedExtension.deploy(...seedExtension.constructorArgs({ easAddress }));
  await seedImpl.waitForDeployment();
  await (
    await factory
      .connect(factoryAdmin)
      .addExtension(
        buildExtension(seedExtension.name, await seedImpl.getAddress(), SeedExtension.interface, seedExtension.functions),
      )
  ).wait();

  // Create the account and fund it so it can prefund UserOperations.
  const accountAddress = await factory.createAccount.staticCall(accountAdmin.address, "0x");
  await (await factory.createAccount(accountAdmin.address, "0x")).wait();
  await (await factoryAdmin.sendTransaction({ to: accountAddress, value: ethers.parseEther("10") })).wait();

  const ManagedAccount = await ethers.getContractFactory("ManagedAccount");
  const accountInterface = mergeInterfaces(ManagedAccount.interface, AccountExtension.interface, SeedExtension.interface);
  const account = new ethers.Contract(accountAddress, accountInterface, accountAdmin);

  return {
    ...easSetup,
    easAddress,
    entryPoint,
    factory,
    accountExtension,
    seedImpl,
    account,
    accountAddress,
    factoryAdmin,
    accountAdmin,
    delegate,
    stranger,
    bundler,
  };
}

/** Default fixture: the Seed extension exactly as deployed on OP Sepolia today. */
async function managedAccountFixture() {
  return deployManagedAccountStack();
}

module.exports = {
  SEED_EXTENSION_CURRENT,
  deployManagedAccountStack,
  managedAccountFixture,
  buildExtension,
  mergeInterfaces,
  setSignerPermissions,
  grantSessionKey,
  revokeSessionKey,
  sendUserOp,
  expectUserOpRejected,
  attestedEvents,
  buildLegacyPublishRequests,
};
