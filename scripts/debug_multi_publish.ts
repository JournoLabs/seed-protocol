import { readFile } from "node:fs/promises";
import path from "node:path";
import { Interface, Wallet, getAddress } from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types/hre";
import { mergeInterfaces } from "./lib/extensions.js";

/**
 * `hardhat seed:debug-publish --account <address> --payload <file>`: simulates
 * `multiPublish` on a live account with `eth_call` and decodes why it reverts
 * (a Seed error, an EAS error, or `Error(string)`). Read-only.
 *
 * The call goes to the account, the way the SDK sends it, so it runs the
 * account's routing and the extension's access checks. `--from` should be an
 * account admin (or the account itself); anyone else gets `Unauthorized`.
 *
 * The payload is a JSON array of publish requests. A cross-reference gives its target
 * either as `publishIndex` or, as in the SDK's publish payload, as `publishLocalId`,
 * which is resolved to that request's index. An unknown or duplicated localId fails
 * here rather than being encoded as the wrong index.
 */

interface Args {
  account: string;
  payload: string;
  from: string;
}

export default async function debugPublishTask(args: Args, hre: HardhatRuntimeEnvironment) {
  if (!args.account || !args.payload) throw new Error("--account and --payload are required");
  const { ethers } = await hre.network.getOrCreate();
  const abi = async (name: string) => new Interface((await hre.artifacts.readArtifact(name)).abi);

  const requests = normalize(JSON.parse(await readFile(path.resolve(process.cwd(), args.payload), "utf8")));
  const extension = await abi("SeedProtocolExtension");
  const errors = mergeInterfaces(extension, await abi("ManagedAccount"), await abi("EAS"));
  const from = args.from ? getAddress(args.from) : (await ethers.getSigners())[0]?.address ?? Wallet.createRandom().address;

  console.log(`Simulating multiPublish on ${args.account}`);
  console.log(`From ${from}, ${requests.length} request(s)`);

  try {
    const result = await ethers.provider.call({
      to: args.account,
      from,
      data: extension.encodeFunctionData("multiPublish", [requests]),
    });
    console.log("Succeeded. Returned UIDs:", extension.decodeFunctionResult("multiPublish", result)[0]);
  } catch (e: any) {
    const data: string | undefined = e.data ?? e.info?.error?.data ?? e.error?.data;
    console.error("Reverted.");
    if (!data || data === "0x") {
      console.error(`  No revert data (${e.shortMessage ?? e.message})`);
    } else {
      let parsed = null;
      try {
        parsed = errors.parseError(data);
      } catch {
        // not an error we know
      }
      console.error(parsed ? `  ${parsed.signature} ${JSON.stringify(parsed.args.toArray(), bigintReplacer)}` : `  Raw: ${data}`);
    }
    process.exitCode = 1;
  }
}

interface PublishRequest {
  propertiesToUpdate: Record<string, unknown>[];
  [key: string]: unknown;
}

/** JSON numbers and strings to the types ethers encodes (uint64/uint256 as bigint). */
function normalize(payload: any[]): PublishRequest[] {
  const indexByLocalId = new Map<string, number>();
  payload.forEach((req, i) => {
    if (!req.localId) return;
    if (indexByLocalId.has(req.localId)) throw new Error(`Duplicate localId "${req.localId}" (requests ${indexByLocalId.get(req.localId)} and ${i})`);
    indexByLocalId.set(req.localId, i);
  });
  const publishIndex = (p: any): bigint => {
    if ("publishIndex" in p) return BigInt(p.publishIndex);
    const index = indexByLocalId.get(p.publishLocalId);
    if (index === undefined) throw new Error(`publishLocalId "${p.publishLocalId}" is not a localId in this payload`);
    return BigInt(index);
  };
  return payload.map((req) => ({
    localId: req.localId,
    seedUid: req.seedUid,
    seedSchemaUid: req.seedSchemaUid,
    versionUid: req.versionUid,
    versionSchemaUid: req.versionSchemaUid,
    seedIsRevocable: req.seedIsRevocable,
    listOfAttestations: req.listOfAttestations.map((a: any) => ({
      schema: a.schema,
      data: a.data.map((d: any) => ({
        recipient: d.recipient,
        expirationTime: BigInt(d.expirationTime),
        revocable: d.revocable,
        refUID: d.refUID,
        data: d.data,
        value: BigInt(d.value),
      })),
    })),
    propertiesToUpdate: (req.propertiesToUpdate ?? []).map((p: any) => ({
      publishIndex: publishIndex(p),
      propertySchemaUid: p.propertySchemaUid,
    })),
  }));
}

function bigintReplacer(_key: string, value: unknown) {
  return typeof value === "bigint" ? value.toString() : value;
}
