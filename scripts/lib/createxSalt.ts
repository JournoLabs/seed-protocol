import { concat, getAddress, toUtf8Bytes, zeroPadBytes } from "ethers";

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
