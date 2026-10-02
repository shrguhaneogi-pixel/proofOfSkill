/**
 * SHA-256 of the canonical submission JSON.
 *
 * Uses WebCrypto, which exists both in the browser and on Node 19+, so client
 * and server run the same code path and cannot disagree about what was hashed.
 */

export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/** Requires an even number of hex digits; used to re-read a stored hash. */
export function hexToBytes(hex: string): Uint8Array {
  if (!/^([0-9a-fA-F]{2})+$/.test(hex)) {
    throw new Error("hex string must contain an even number of hex digits");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export async function sha256Bytes(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return new Uint8Array(digest);
}

export async function sha256Hex(input: string): Promise<string> {
  return bytesToHex(await sha256Bytes(input));
}

/** Anchor maps a Rust `[u8; 32]` to a plain `number[]` on the TypeScript side. */
export async function sha256Array(input: string): Promise<number[]> {
  const bytes = await sha256Bytes(input);
  if (bytes.length !== 32) {
    throw new Error(`expected a 32 byte digest, got ${bytes.length}`);
  }
  return Array.from(bytes);
}
