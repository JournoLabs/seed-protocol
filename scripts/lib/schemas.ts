import { readFileSync } from "node:fs";
import { ZeroAddress, ZeroHash, getAddress, keccak256, solidityPacked } from "ethers";
import type { Contract } from "ethers";

/**
 * The protocol's base EAS schemas (schemas/base-schemas.json), and checking or
 * registering them on a SchemaRegistry (docs/local-twin-plan.md, T4).
 */

export interface BaseSchema {
  key: string;
  schema: string;
  resolver: string;
  revocable: boolean;
  uid: string;
  purpose: string;
}

export const BASE_SCHEMAS: BaseSchema[] = JSON.parse(
  readFileSync(new URL("../../schemas/base-schemas.json", import.meta.url), "utf8"),
).schemas;

/** SchemaRegistry's UID: keccak256(abi.encodePacked(schema, resolver, revocable)). */
export function schemaUid(schema: string, resolver: string = ZeroAddress, revocable = true): string {
  return keccak256(solidityPacked(["string", "address", "bool"], [schema, resolver, revocable]));
}

export type SchemaStatus = "registered" | "missing" | "registered now";

/** Whether each base schema is on `registry`, registering the missing ones when `register` is set. */
export async function ensureBaseSchemas(
  registry: Contract,
  { register = false, schemas = BASE_SCHEMAS }: { register?: boolean; schemas?: BaseSchema[] } = {},
): Promise<{ schema: BaseSchema; status: SchemaStatus }[]> {
  const results: { schema: BaseSchema; status: SchemaStatus }[] = [];
  for (const schema of schemas) {
    const uid = schemaUid(schema.schema, schema.resolver, schema.revocable);
    if (uid !== schema.uid) throw new Error(`${schema.key}: schemas/base-schemas.json says ${schema.uid}, computed ${uid}`);

    if ((await registry.getSchema(uid)).uid !== ZeroHash) {
      results.push({ schema, status: "registered" });
    } else if (register) {
      await (await registry.register(schema.schema, getAddress(schema.resolver), schema.revocable)).wait();
      results.push({ schema, status: "registered now" });
    } else {
      results.push({ schema, status: "missing" });
    }
  }
  return results;
}
