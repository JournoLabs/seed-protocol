import {
  AbiCoder,
  ZeroAddress,
  concat,
  dataSlice,
  getAddress,
  getCreate2Address,
  keccak256,
  toUtf8Bytes,
  zeroPadBytes,
  zeroPadValue,
} from "ethers";

/** CreateX v0.1.0, at the same address on every chain it's deployed to. */
export const CREATE_X = "0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed";

/**
 * The only address that gets the canonical Seed addresses (P2). It must be the key
 * that runs `ignition deploy` on public networks (input I7). Today that's DEV_KEY.
 */
export const SEED_DEPLOYER = "0x00467fe2608Dff148C83009927E4e7234Bc4D84B";

/** The create2 salt in hardhat.config.ts. */
export const SEED_SALT_LABEL = "seed-v1";

/**
 * A CreateX salt that only `deployer` can use (docs/deploy-plan.md, P2):
 * bytes 0–19 = deployer, byte 20 = 0x00, bytes 21–31 = `label`.
 *
 * CreateX's `_guard` turns this into `keccak256(deployer ‖ salt)` when `msg.sender`
 * is `deployer`. Byte 20 = 0x00 turns off cross-chain redeploy protection, so the
 * same deployer gets the same address on every chain. Any other sender falls into
 * CreateX's "random" case, `keccak256(abi.encode(salt))`, and lands elsewhere.
 */
export function createxSalt(deployer: string, label: string): string {
  const labelBytes = toUtf8Bytes(label);
  if (labelBytes.length > 11) throw new Error(`createxSalt: label "${label}" is over 11 bytes`);
  return concat([getAddress(deployer), "0x00", zeroPadBytes(labelBytes, 11)]);
}

/**
 * The salt CreateX's `_guard` passes to CREATE2 when `sender` calls
 * `deployCreate2(salt, …)`, for the two cases `createxSalt` can produce.
 */
export function guardedSalt(salt: string, sender: string): string {
  const saltSender = dataSlice(salt, 0, 20);
  if (getAddress(saltSender) === getAddress(sender) && dataSlice(salt, 20, 21) === "0x00") {
    return keccak256(concat([zeroPadValue(sender, 32), salt]));
  }
  if (dataSlice(salt, 20, 21) !== "0x00" && dataSlice(salt, 20, 21) !== "0x01") {
    throw new Error("guardedSalt: only handles byte 20 = 0x00 or 0x01");
  }
  if (saltSender === ZeroAddress) throw new Error("guardedSalt: zero-address salts aren't handled");
  // Anyone else using the salt: CreateX's "random" branch.
  return keccak256(AbiCoder.defaultAbiCoder().encode(["bytes32"], [salt]));
}

/** Where `deployCreate2(salt, initCode)` from `sender` puts the contract. */
export function createxAddress(salt: string, sender: string, initCode: string): string {
  return getCreate2Address(CREATE_X, guardedSalt(salt, sender), keccak256(initCode));
}
