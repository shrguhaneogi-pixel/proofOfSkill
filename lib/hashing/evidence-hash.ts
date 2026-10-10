/**
 * SHA-256 of the canonical submission JSON.
 *
 * Uses WebCrypto, which exists both in the browser and on Node 19+, so client
 * and server run the same code path and cannot disagree about what was hashed.
 *
 * `evidencePreimage` is the single definition of what an `evidence_hash` covers:
 * the canonical submission alone, or that plus the digest of a repository we
 * fetched. See `canonicalize.ts` for the submission half.
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

/* ------------------------------------------------------------------ *
 * Evidence preimage, with an optional fetched-repository digest
 * ------------------------------------------------------------------ */

/**
 * Tag carried in the preimage when repository content was fetched, so the shape
 * of what was hashed is recorded in the bytes and not only in the code that
 * produced them.
 */
export const EVIDENCE_REPO_TAG = "proofofskill/evidence-v2";

/**
 * The exact string that gets hashed for an `evidence_hash`.
 *
 * Two shapes, and the choice is not cosmetic:
 * - no repository content was fetched → the canonical submission string,
 *   unchanged since before Phase 3. Every credential already onchain keeps
 *   verifying, and a caller that re-derives a hash without evidence gets the
 *   historical value.
 * - repository content was fetched → a JSON envelope around that same canonical
 *   string plus the digest of the tree we read, so the credential attests to the
 *   commit graded and not merely to the text typed into the form.
 *
 * A submission with no fetched content must therefore hash exactly as it did
 * before: `repoDigest` is omitted entirely rather than included as an empty
 * value, which is what keeps the pinned vectors in `canonicalize.test.ts` valid.
 */
export function evidencePreimage(canonicalSubmission: string, repoDigest?: string): string {
  if (repoDigest === undefined || repoDigest === "") {
    return canonicalSubmission;
  }
  return JSON.stringify({
    evidence: EVIDENCE_REPO_TAG,
    repoDigest,
    submission: canonicalSubmission,
  });
}

/** SHA-256 of `evidencePreimage`; the async sibling of `sha256Hex` for callers that hold a canonical string. */
export async function sha256EvidenceHash(canonicalSubmission: string, repoDigest?: string): Promise<string> {
  return sha256Hex(evidencePreimage(canonicalSubmission, repoDigest));
}
