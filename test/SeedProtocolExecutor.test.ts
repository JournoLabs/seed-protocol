import { expect } from "chai";
import { AbiCoder, type ContractTransactionReceipt, Interface, ZeroAddress, ZeroHash, id, parseEther } from "ethers";
import { network } from "hardhat";
import { MODULE_TYPE_EXECUTOR, createExecutorEASFixture } from "./fixtures/executorEASFixture.js";
import { expectCustomError } from "./fixtures/managedAccountFixture.js";

const connection = await network.create();
const { ethers, networkHelpers } = connection;
const executorEASFixture = createExecutorEASFixture(connection);

type Setup = Awaited<ReturnType<typeof executorEASFixture>>;

/**
 * End-to-end tests for SeedProtocolExecutor (ERC-7579 Executor Module)
 *
 * Test architecture:
 *   [Owner EOA] → [MockERC7579Account] → [SeedProtocolExecutor] → [MockERC7579Account.executeFromExecutor] → [EAS]
 *
 * The critical assertion: EAS sees msg.sender == the Account address,
 * NOT the Executor module address. This proves attestation ownership is correct.
 */
describe("SeedProtocolExecutor", function () {
  let eas: Setup["eas"];
  let executor: Setup["executor"];
  let account: Setup["account"];
  let owner: Setup["owner"];
  let otherUser: Setup["otherUser"];
  let SEED_SCHEMA_UID: string;
  let VERSION_SCHEMA_UID: string;
  let PROPERTY_SCHEMA_UID: string;

  beforeEach(async function () {
    const fixture = await networkHelpers.loadFixture(executorEASFixture);
    eas = fixture.eas;
    executor = fixture.executor;
    account = fixture.account;
    owner = fixture.owner;
    otherUser = fixture.otherUser;
    SEED_SCHEMA_UID = fixture.seedSchemaUid;
    VERSION_SCHEMA_UID = fixture.versionSchemaUid;
    PROPERTY_SCHEMA_UID = fixture.propertySchemaUid;
  });

  async function callExecutorFromAccount(functionName: string, args: unknown[], value = 0n) {
    const calldata = (executor.interface as Interface).encodeFunctionData(functionName, args);
    const tx = await account.execute(
      await executor.getAddress(),
      value,
      calldata,
      { value }
    );
    return tx;
  }

  /** Run createSeed and return the attestation UID from the CreatedAttestation event. */
  async function createSeedAndGetUid() {
    const tx = await callExecutorFromAccount("createSeed", [SEED_SCHEMA_UID]);
    const receipt = await tx.wait();
    const uids = await getCreatedAttestationUids(receipt);
    return uids[0];
  }

  /** Run createVersion and return the attestation UID from the CreatedAttestation event. */
  async function createVersionAndGetUid(seedUid: string) {
    const tx = await callExecutorFromAccount("createVersion", [seedUid, VERSION_SCHEMA_UID]);
    const receipt = await tx.wait();
    const uids = await getCreatedAttestationUids(receipt);
    return uids[0];
  }

  /** Run publish and return seedUid and versionUid from CreatedAttestation events (order: seed, version). */
  async function publishAndGetUids(request: { seedUid: string; versionUid: string }) {
    const tx = await callExecutorFromAccount("publish", [request]);
    const receipt = await tx.wait();
    const uids = await getCreatedAttestationUids(receipt);
    return {
      seedUid: uids[0] ?? request.seedUid,
      versionUid: uids[1] ?? uids[0] ?? request.versionUid,
    };
  }

  /** Parse CreatedAttestation events from a tx receipt; returns array of attestationUids in order. */
  async function getCreatedAttestationUids(receipt: ContractTransactionReceipt | null): Promise<string[]> {
    const addr = await executor.getAddress();
    const uids: string[] = [];
    for (const log of receipt?.logs ?? []) {
      if (log.address.toLowerCase() !== addr.toLowerCase()) continue;
      try {
        const parsed = executor.interface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed && parsed.name === "CreatedAttestation") {
          const result = parsed.args[0];
          uids.push(result.attestationUid ?? result[1]);
        }
      } catch {}
    }
    return uids;
  }

  /** Parse EAS Attested events from a tx receipt; returns array of UIDs in creation order. */
  async function getEASAttestedUids(receipt: ContractTransactionReceipt | null): Promise<string[]> {
    const addr = (await eas.getAddress()).toLowerCase();
    const uids: string[] = [];
    for (const log of receipt?.logs ?? []) {
      if (log.address.toLowerCase() !== addr) continue;
      try {
        const parsed = eas.interface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed && parsed.name === "Attested") uids.push(parsed.args[2]);
      } catch {}
    }
    return uids;
  }

  describe("Module Lifecycle", function () {
    it("should report as executor module type", async function () {
      expect(await executor.isModuleType(MODULE_TYPE_EXECUTOR)).to.be.true;
      expect(await executor.isModuleType(1)).to.be.false;
      expect(await executor.isModuleType(3)).to.be.false;
      expect(await executor.isModuleType(4)).to.be.false;
    });

    it("should be initialized with correct EAS address after install", async function () {
      const accountAddr = await account.getAddress();
      expect(await executor.isInitialized(accountAddr)).to.be.true;
      expect(await executor.getEAS(accountAddr)).to.equal(await eas.getAddress());
    });

    it("should NOT be initialized for a random address", async function () {
      expect(await executor.isInitialized(otherUser.address)).to.be.false;
    });

    it("should revert if installed twice on the same account", async function () {
      const initData = AbiCoder.defaultAbiCoder().encode(
        ["address"],
        [await eas.getAddress()]
      );
      await expect(
        account.installModule(MODULE_TYPE_EXECUTOR, await executor.getAddress(), initData)
      ).to.be.revert(ethers);
    });

    it("should uninstall cleanly", async function () {
      const accountAddr = await account.getAddress();
      await account.uninstallModule(
        MODULE_TYPE_EXECUTOR,
        await executor.getAddress(),
        "0x"
      );
      expect(await executor.isInitialized(accountAddr)).to.be.false;
      expect(await executor.getEAS(accountAddr)).to.equal(ZeroAddress);
    });

    it("should revert operations after uninstall", async function () {
      await account.uninstallModule(
        MODULE_TYPE_EXECUTOR,
        await executor.getAddress(),
        "0x"
      );
      await expect(
        callExecutorFromAccount("createSeed", [SEED_SCHEMA_UID])
      ).to.be.revert(ethers);
    });

    it("should revert onInstall with zero EAS address", async function () {
      const freshAccount = await ethers.deployContract("MockERC7579Account", [owner.address]);
      await freshAccount.waitForDeployment();
      const badInitData = AbiCoder.defaultAbiCoder().encode(
        ["address"],
        [ZeroAddress]
      );
      await expect(
        freshAccount.installModule(MODULE_TYPE_EXECUTOR, await executor.getAddress(), badInitData)
      ).to.be.revert(ethers);
    });
  });

  describe("createSeed", function () {
    it("should create an attestation and return a non-zero UID", async function () {
      const seedUid = await createSeedAndGetUid();
      expect(seedUid).to.not.equal(ZeroHash);
      const att = await eas.getAttestation(seedUid);
      expect(att.uid).to.equal(seedUid);
    });

    it("should make the ACCOUNT the attester, not the executor module", async function () {
      const uid = await createSeedAndGetUid();
      const attestation = await eas.getAttestation(uid);
      const accountAddr = await account.getAddress();
      const executorAddr = await executor.getAddress();
      expect(attestation.attester).to.equal(accountAddr);
      expect(attestation.attester).to.not.equal(executorAddr);
    });

    it("should store the correct schema UID in the attestation", async function () {
      const uid = await createSeedAndGetUid();
      const attestation = await eas.getAttestation(uid);
      expect(attestation.schema).to.equal(SEED_SCHEMA_UID);
    });

    it("should emit CreatedAttestation event", async function () {
      const calldata = executor.interface.encodeFunctionData(
        "createSeed",
        [SEED_SCHEMA_UID]
      );
      const tx = await account.execute(
        await executor.getAddress(),
        0,
        calldata
      );
      const receipt = await tx.wait();
      const executorAddr = await executor.getAddress();
      const createdAttestationEvents = (receipt?.logs ?? []).filter(
        (log) => log.address.toLowerCase() === executorAddr.toLowerCase()
      );
      expect(createdAttestationEvents.length).to.be.greaterThan(0);
    });

    it("should always create revocable seeds", async function () {
      const uid = await createSeedAndGetUid();
      const att = await eas.getAttestation(uid);
      expect(att.revocable).to.be.true;
    });
  });

  describe("createVersion", function () {
    let seedUid: string;

    beforeEach(async function () {
      seedUid = await createSeedAndGetUid();
    });

    it("should create a version attestation referencing the seed", async function () {
      const versionUid = await createVersionAndGetUid(seedUid);
      const attestation = await eas.getAttestation(versionUid);
      expect(attestation.schema).to.equal(VERSION_SCHEMA_UID);
      expect(attestation.refUID).to.equal(seedUid);
    });

    it("should make the account the attester of the version", async function () {
      const versionUid = await createVersionAndGetUid(seedUid);
      const attestation = await eas.getAttestation(versionUid);
      expect(attestation.attester).to.equal(await account.getAddress());
    });

    it("should always set version as revocable", async function () {
      const versionUid = await createVersionAndGetUid(seedUid);
      const attestation = await eas.getAttestation(versionUid);
      expect(attestation.revocable).to.be.true;
    });
  });

  describe("publish", function () {
    it("should create both seed and version when both UIDs are zero", async function () {
      const request = {
        localId: "test-local-1",
        seedUid: ZeroHash,
        versionUid: ZeroHash,
        seedSchemaUid: SEED_SCHEMA_UID,
        versionSchemaUid: VERSION_SCHEMA_UID,
        seedIsRevocable: true,
        listOfAttestations: [],
        propertiesToUpdate: [],
      };
      const { seedUid, versionUid } = await publishAndGetUids(request);
      expect(seedUid).to.not.equal(ZeroHash);
      expect(versionUid).to.not.equal(ZeroHash);
      const seedAtt = await eas.getAttestation(seedUid);
      expect(seedAtt.schema).to.equal(SEED_SCHEMA_UID);
      const versionAtt = await eas.getAttestation(versionUid);
      expect(versionAtt.schema).to.equal(VERSION_SCHEMA_UID);
      expect(versionAtt.refUID).to.equal(seedUid);
    });

    it("should skip seed creation when seedUid is provided", async function () {
      const existingSeedUid = await createSeedAndGetUid();
      const request = {
        localId: "test-local-2",
        seedUid: existingSeedUid,
        versionUid: ZeroHash,
        seedSchemaUid: SEED_SCHEMA_UID,
        versionSchemaUid: VERSION_SCHEMA_UID,
        seedIsRevocable: true,
        listOfAttestations: [],
        propertiesToUpdate: [],
      };
      const { versionUid } = await publishAndGetUids(request);
      expect(versionUid).to.not.equal(ZeroHash);
      const versionAtt = await eas.getAttestation(versionUid);
      expect(versionAtt.refUID).to.equal(existingSeedUid);
    });

    it("should skip both when both UIDs are provided", async function () {
      const existingSeedUid = await createSeedAndGetUid();
      const existingVersionUid = await createVersionAndGetUid(existingSeedUid);
      const request = {
        localId: "test-local-3",
        seedUid: existingSeedUid,
        versionUid: existingVersionUid,
        seedSchemaUid: SEED_SCHEMA_UID,
        versionSchemaUid: VERSION_SCHEMA_UID,
        seedIsRevocable: true,
        listOfAttestations: [],
        propertiesToUpdate: [],
      };
      await callExecutorFromAccount("publish", [request]);
      const seedAtt = await eas.getAttestation(existingSeedUid);
      const versionAtt = await eas.getAttestation(existingVersionUid);
      expect(seedAtt.uid).to.equal(existingSeedUid);
      expect(versionAtt.uid).to.equal(existingVersionUid);
    });
  });

  describe("multiPublish", function () {
    it("should process multiple publish requests", async function () {
      const requests = [
        {
          localId: "request-1",
          seedUid: ZeroHash,
          versionUid: ZeroHash,
          seedSchemaUid: SEED_SCHEMA_UID,
          versionSchemaUid: VERSION_SCHEMA_UID,
          seedIsRevocable: true,
          listOfAttestations: [],
          propertiesToUpdate: [],
        },
        {
          localId: "request-2",
          seedUid: ZeroHash,
          versionUid: ZeroHash,
          seedSchemaUid: SEED_SCHEMA_UID,
          versionSchemaUid: VERSION_SCHEMA_UID,
          seedIsRevocable: false,
          listOfAttestations: [],
          propertiesToUpdate: [],
        },
      ];
      const tx = await callExecutorFromAccount("multiPublish", [requests]);
      const receipt = await tx.wait();
      const uids = await getCreatedAttestationUids(receipt);
      expect(uids.length).to.equal(4);
    });

    it("should update refUIDs on listOfAttestations to the new versionUid", async function () {
      const propertyAttData = {
        recipient: ZeroAddress,
        expirationTime: 0n,
        revocable: true,
        refUID: ZeroHash,
        data: AbiCoder.defaultAbiCoder().encode(["string"], ["test-property-value"]),
        value: 0n,
      };
      const requests = [
        {
          localId: "request-with-props",
          seedUid: ZeroHash,
          versionUid: ZeroHash,
          seedSchemaUid: SEED_SCHEMA_UID,
          versionSchemaUid: VERSION_SCHEMA_UID,
          seedIsRevocable: true,
          listOfAttestations: [
            { schema: PROPERTY_SCHEMA_UID, data: [propertyAttData] },
          ],
          propertiesToUpdate: [],
        },
      ];
      const tx = await callExecutorFromAccount("multiPublish", [requests]);
      const receipt = await tx.wait();
      const uids = await getEASAttestedUids(receipt);
      expect(uids.length).to.equal(3);
      const versionUid = uids[1];
      const propertyUid = uids[2];
      const propertyAtt = await eas.getAttestation(propertyUid);
      expect(propertyAtt.refUID).to.equal(versionUid);
      expect(propertyAtt.schema).to.equal(PROPERTY_SCHEMA_UID);
    });

    it("should cross-reference seedUids between requests via propertiesToUpdate", async function () {
      const crossRefPropertyData = {
        recipient: ZeroAddress,
        expirationTime: 0n,
        revocable: true,
        refUID: ZeroHash,
        data: AbiCoder.defaultAbiCoder().encode(["bytes32"], [ZeroHash]),
        value: 0n,
      };
      const requests = [
        {
          localId: "parent-request",
          seedUid: ZeroHash,
          versionUid: ZeroHash,
          seedSchemaUid: SEED_SCHEMA_UID,
          versionSchemaUid: VERSION_SCHEMA_UID,
          seedIsRevocable: true,
          listOfAttestations: [],
          propertiesToUpdate: [
            { publishIndex: 1, propertySchemaUid: PROPERTY_SCHEMA_UID },
          ],
        },
        {
          localId: "child-request",
          seedUid: ZeroHash,
          versionUid: ZeroHash,
          seedSchemaUid: SEED_SCHEMA_UID,
          versionSchemaUid: VERSION_SCHEMA_UID,
          seedIsRevocable: true,
          listOfAttestations: [
            { schema: PROPERTY_SCHEMA_UID, data: [crossRefPropertyData] },
          ],
          propertiesToUpdate: [],
        },
      ];
      const tx = await callExecutorFromAccount("multiPublish", [requests]);
      const receipt = await tx.wait();
      const uids = await getEASAttestedUids(receipt);
      expect(uids.length).to.equal(5);
      const parentSeedUid = uids[0];
      const childPropertyUid = uids[4];
      const childPropertyAtt = await eas.getAttestation(childPropertyUid);
      const decodedData = AbiCoder.defaultAbiCoder().decode(
        ["bytes32"],
        childPropertyAtt.data
      );
      expect(decodedData[0]).to.equal(parentSeedUid);
    });

    it("should revert when publishIndex is out of bounds", async function () {
      const requests = [
        {
          localId: "parent",
          seedUid: ZeroHash,
          versionUid: ZeroHash,
          seedSchemaUid: SEED_SCHEMA_UID,
          versionSchemaUid: VERSION_SCHEMA_UID,
          seedIsRevocable: true,
          listOfAttestations: [],
          propertiesToUpdate: [
            { publishIndex: 99, propertySchemaUid: PROPERTY_SCHEMA_UID },
          ],
        },
      ];
      const [targetIndex, length] = await expectCustomError(
        callExecutorFromAccount("multiPublish", [requests]),
        executor.interface as Interface,
        "PublishIndexOutOfBounds"
      );
      expect(targetIndex).to.equal(99n);
      expect(length).to.equal(1n);
    });

    it("should make the account the attester for all multiAttest attestations", async function () {
      const propertyAttData = {
        recipient: ZeroAddress,
        expirationTime: 0n,
        revocable: true,
        refUID: ZeroHash,
        data: AbiCoder.defaultAbiCoder().encode(["string"], ["value"]),
        value: 0n,
      };
      const requests = [
        {
          localId: "attester-test",
          seedUid: ZeroHash,
          versionUid: ZeroHash,
          seedSchemaUid: SEED_SCHEMA_UID,
          versionSchemaUid: VERSION_SCHEMA_UID,
          seedIsRevocable: true,
          listOfAttestations: [
            { schema: PROPERTY_SCHEMA_UID, data: [propertyAttData] },
          ],
          propertiesToUpdate: [],
        },
      ];
      const tx = await callExecutorFromAccount("multiPublish", [requests]);
      const receipt = await tx.wait();
      const uids = await getCreatedAttestationUids(receipt);
      const accountAddr = await account.getAddress();
      for (const uid of uids) {
        const att = await eas.getAttestation(uid);
        expect(att.attester).to.equal(accountAddr);
      }
    });
  });

  describe("Access Control", function () {
    it("should revert if an EOA calls executor functions directly", async function () {
      await expect(
        executor.connect(owner).createSeed(SEED_SCHEMA_UID)
      ).to.be.revert(ethers);
    });

    it("should revert if a non-owner tries to install modules on the account", async function () {
      const freshAccount = await ethers.deployContract("MockERC7579Account", [owner.address]);
      await freshAccount.waitForDeployment();
      const initData = AbiCoder.defaultAbiCoder().encode(
        ["address"],
        [await eas.getAddress()]
      );
      await expect(
        freshAccount.connect(otherUser).installModule(
          MODULE_TYPE_EXECUTOR,
          await executor.getAddress(),
          initData
        )
      ).to.be.revert(ethers);
    });

    it("should revert if a non-owner tries to execute through the account", async function () {
      const calldata = executor.interface.encodeFunctionData(
        "createSeed",
        [SEED_SCHEMA_UID]
      );
      await expect(
        account.connect(otherUser).execute(
          await executor.getAddress(),
          0,
          calldata
        )
      ).to.be.revert(ethers);
    });
  });

  describe("Multi-Account Isolation", function () {
    let account2: Setup["account"];

    beforeEach(async function () {
      const [o] = await ethers.getSigners();
      const schemaRegistry2 = await ethers.deployContract("SchemaRegistry");
      await schemaRegistry2.waitForDeployment();
      const eas2 = await ethers.deployContract("EAS", [await schemaRegistry2.getAddress()]);
      await eas2.waitForDeployment();
      const eas2Address = await eas2.getAddress();
      await schemaRegistry2.register("bytes32 post", ZeroAddress, true);
      await schemaRegistry2.register("bytes32 version", ZeroAddress, true);
      await schemaRegistry2.register("string value", ZeroAddress, true);
      account2 = await ethers.deployContract("MockERC7579Account", [o.address]);
      await account2.waitForDeployment();
      const initData = AbiCoder.defaultAbiCoder().encode(
        ["address"],
        [eas2Address]
      );
      await account2.installModule(MODULE_TYPE_EXECUTOR, await executor.getAddress(), initData);
    });

    it("should track separate EAS addresses per account", async function () {
      const eas1 = await executor.getEAS(await account.getAddress());
      const eas2 = await executor.getEAS(await account2.getAddress());
      expect(eas1).to.not.equal(eas2);
      expect(eas1).to.equal(await eas.getAddress());
    });

    it("should not allow one account to affect another's state", async function () {
      await account.uninstallModule(MODULE_TYPE_EXECUTOR, await executor.getAddress(), "0x");
      expect(await executor.isInitialized(await account2.getAddress())).to.be.true;
      expect(await executor.isInitialized(await account.getAddress())).to.be.false;
    });
  });

  /** One request creating a seed + version and a single "string value" property. */
  function requestWithProperty({ revocable = true } = {}) {
    return {
      localId: "with-property",
      seedUid: ZeroHash,
      versionUid: ZeroHash,
      seedSchemaUid: SEED_SCHEMA_UID,
      versionSchemaUid: VERSION_SCHEMA_UID,
      seedIsRevocable: revocable,
      listOfAttestations: [
        {
          schema: PROPERTY_SCHEMA_UID,
          data: [
            {
              recipient: ZeroAddress,
              expirationTime: 0n,
              revocable,
              refUID: ZeroHash,
              data: AbiCoder.defaultAbiCoder().encode(["string"], ["value"]),
              value: 0n,
            },
          ],
        },
      ],
      propertiesToUpdate: [] as { publishIndex: number; propertySchemaUid: string }[],
    };
  }

  describe("Value handling (F6)", function () {
    it("forwards msg.value to EAS once and keeps none of it in the module", async function () {
      const executorAddr = await executor.getAddress();
      const accountAddr = await account.getAddress();
      const value = parseEther("1");
      const accountBefore = await ethers.provider.getBalance(accountAddr);

      await (await callExecutorFromAccount("multiPublish", [[requestWithProperty(), requestWithProperty()]], value)).wait();

      // EAS refunds unused value to its caller, the account; nothing may stay in the module.
      expect(await ethers.provider.getBalance(executorAddr)).to.equal(0n);
      expect(await ethers.provider.getBalance(accountAddr)).to.equal(accountBefore + value);
    });

    it("rejects value when no attestation batch would consume it", async function () {
      const request = { ...requestWithProperty(), listOfAttestations: [] };
      const value = parseEther("1");
      const [unused] = await expectCustomError(
        callExecutorFromAccount("multiPublish", [[request]], value),
        executor.interface as Interface,
        "UnusedValue",
      );
      expect(unused).to.equal(value);
    });

    it("does not accept value on createSeed, createVersion or publish", async function () {
      await expect(callExecutorFromAccount("createSeed", [SEED_SCHEMA_UID], 1n)).to.be.revert(ethers);
      await expect(callExecutorFromAccount("publish", [requestWithProperty()], 1n)).to.be.revert(ethers);
    });
  });

  describe("Lifecycle guards", function () {
    it("ignores onUninstall sent through the account while the module is still installed", async function () {
      // e.g. a session key allowed to target the executor trying to break publishing
      const accountAddr = await account.getAddress();
      const [who] = await expectCustomError(
        callExecutorFromAccount("onUninstall", ["0x"]),
        executor.interface as Interface,
        "StillInstalledOnAccount",
      );
      expect(who).to.equal(accountAddr);
      expect(await executor.isInitialized(accountAddr)).to.be.true;
      expect(await executor.getEAS(accountAddr)).to.equal(await eas.getAddress());
    });

    it("ignores onInstall sent through an account that hasn't installed the module", async function () {
      const freshAccount = await ethers.deployContract("MockERC7579Account", [owner.address]);
      await freshAccount.waitForDeployment();
      const initData = AbiCoder.defaultAbiCoder().encode(["address"], [otherUser.address]);
      const calldata = executor.interface.encodeFunctionData("onInstall", [initData]);

      await expectCustomError(
        freshAccount.execute(await executor.getAddress(), 0n, calldata),
        executor.interface as Interface,
        "NotInstalledOnAccount",
      );
      expect(await executor.isInitialized(await freshAccount.getAddress())).to.be.false;
    });

    it("rejects onInstall/onUninstall from an EOA", async function () {
      const initData = AbiCoder.defaultAbiCoder().encode(["address"], [await eas.getAddress()]);
      await expect(executor.connect(otherUser).onInstall(initData)).to.be.revert(ethers);
      await expect(executor.connect(otherUser).onUninstall("0x")).to.be.revert(ethers);
    });
  });

  describe("Client refUID", function () {
    it("preserves a refUID the client set instead of pointing it at the new version", async function () {
      const [earlierSeed] = await getEASAttestedUids(
        await (await callExecutorFromAccount("multiPublish", [[requestWithProperty()]])).wait()
      );

      const request = requestWithProperty();
      request.listOfAttestations[0].data[0].refUID = earlierSeed;
      const [, versionUid, propertyUid] = await getEASAttestedUids(
        await (await callExecutorFromAccount("multiPublish", [[request]])).wait()
      );

      expect((await eas.getAttestation(propertyUid)).refUID).to.equal(earlierSeed);
      expect(versionUid).to.not.equal(earlierSeed);
    });
  });

  describe("Revocability (D7a)", function () {
    it("forces seed and property attestations revocable even when the request asks otherwise", async function () {
      const tx = await callExecutorFromAccount("multiPublish", [[requestWithProperty({ revocable: false })]]);
      const uids = await getEASAttestedUids(await tx.wait());
      expect(uids.length).to.equal(3);
      for (const uid of uids) {
        expect((await eas.getAttestation(uid)).revocable).to.be.true;
      }
    });
  });

  describe("Cross-references (F9)", function () {
    it("rejects referencing a request that was already attested", async function () {
      const target = requestWithProperty();
      const referrer = {
        ...requestWithProperty(),
        localId: "referrer",
        propertiesToUpdate: [{ publishIndex: 0, propertySchemaUid: PROPERTY_SCHEMA_UID }],
      };
      const [requestIndex, targetIndex] = await expectCustomError(
        callExecutorFromAccount("multiPublish", [[target, referrer]]),
        executor.interface as Interface,
        "PublishTargetAlreadyAttested",
      );
      expect(requestIndex).to.equal(1n);
      expect(targetIndex).to.equal(0n);
    });

    it("rejects a reference to a property schema the target request doesn't contain", async function () {
      const missingSchema = id("not-in-the-batch");
      const referrer = {
        ...requestWithProperty(),
        localId: "referrer",
        propertiesToUpdate: [{ publishIndex: 1, propertySchemaUid: missingSchema }],
      };
      const [requestIndex, targetIndex, schema] = await expectCustomError(
        callExecutorFromAccount("multiPublish", [[referrer, requestWithProperty()]]),
        executor.interface as Interface,
        "PropertyToUpdateNotFound",
      );
      expect(requestIndex).to.equal(0n);
      expect(targetIndex).to.equal(1n);
      expect(schema).to.equal(missingSchema);
    });
  });

  describe("Revocation (F8, declined)", function () {
    it("does not expose revocation", async function () {
      // Anything that can drive the module through the account, including a delegate's
      // session key, would be able to revoke all of the account's attestations: the
      // account can't tell which signer is behind a call. Owners revoke via execute(EAS, ...).
      const iface = executor.interface as Interface;
      expect(iface.getFunction("revoke")).to.equal(null);
      expect(iface.getFunction("multiRevoke")).to.equal(null);
    });
  });
});
