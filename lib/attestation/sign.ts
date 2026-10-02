/**
 * Mints the HMAC attestation token that gates `POST /api/issue`.
 *
 * The token is the only thing that proves the server — not the browser — decided
 * that a submission passed. Shape from `docs/api-schema.md` → ATTESTATION:
 * `base64url(payloadJson) + "." + base64url(HMAC_SHA256(ATTESTATION_SECRET, payloadJson))`.
 *
 * Server-only: `ATTESTATION_SECRET` must never reach a client bundle.
 */
import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { CHALLENGE_IDS } from "../challenges/types";
import { MAX_SCORE, PASS_THRESHOLD } from "../program-contract";

export const ATTESTATION_SECRET_ENV = "ATTESTATION_SECRET";

// A score below the pass threshold can never become a credential, so these come from the single
// module that mirrors the onchain constants instead of being restated here.
export { MAX_SCORE, PASS_THRESHOLD };

/** Short-lived by design: the MVP token is not bound to a wallet (see README limitations). */
export const ATTESTATION_TTL_SECONDS = 15 * 60;

/** Matches `docs/api-schema.md`: ">= 32 random bytes, hex/base64". */
export const MIN_KEY_BYTES = 32;

const HEX_MATERIAL = /^(?:[0-9a-fA-F]{2})+$/;
const BASE64_MATERIAL = /^[A-Za-z0-9+/_-]{16,}={0,2}$/;
const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;

// Challenge ids are the contiguous range declared in lib/challenges/types.ts,
// so min/max is exactly the accepted set without hardcoding a second copy.
const MIN_CHALLENGE_ID = CHALLENGE_IDS[0];
const MAX_CHALLENGE_ID = CHALLENGE_IDS[CHALLENGE_IDS.length - 1];

/**
 * `exp` is epoch **seconds** (the `exp` convention the ecosystem already agrees
 * on), so it survives a JSON round trip without a Date.
 */
export const AttestationPayloadSchema = z.object({
  challengeId: z.int().min(MIN_CHALLENGE_ID).max(MAX_CHALLENGE_ID),
  score: z.int().min(0).max(MAX_SCORE),
  evidenceHash: z.string().regex(/^([0-9a-f]{2}){32}$/),
  exp: z.int().min(1),
});

export type AttestationPayload = z.infer<typeof AttestationPayloadSchema>;

/** What the caller supplies; `exp` is derived from the server clock. */
export type AttestationClaims = {
  challengeId: number;
  score: number;
  evidenceHash: string;
};

export type SignResult = { ok: true; data: string } | { ok: false; error: string };

const AttestationClaimsSchema = AttestationPayloadSchema.omit({ exp: true });

/**
 * Accepts hex, base64/base64url, or plain text secret material and returns the
 * bytes to key the HMAC with. Hex is tried first, then base64, then the raw
 * text, so a value is always decoded the same way on every run. Returns `null`
 * when the material decodes to fewer than 32 bytes — too weak to sign with.
 */
export function keyBytesFromMaterial(material: string): Uint8Array | null {
  const trimmed = material.trim();
  if (trimmed === "") {
    return null;
  }
  let bytes: Uint8Array;
  if (HEX_MATERIAL.test(trimmed)) {
    bytes = Buffer.from(trimmed, "hex");
  } else if (BASE64_MATERIAL.test(trimmed)) {
    bytes = Buffer.from(trimmed, "base64url");
  } else {
    bytes = Buffer.from(trimmed, "utf8");
  }
  if (bytes.length < MIN_KEY_BYTES) {
    return null;
  }
  return bytes;
}

/** Resolves the HMAC key from an explicit value or `process.env`; `null` when unusable. */
export function attestationKey(secret?: string): Uint8Array | null {
  const material = secret ?? process.env[ATTESTATION_SECRET_ENV];
  if (typeof material !== "string") {
    return null;
  }
  return keyBytesFromMaterial(material);
}

export function encodeBase64Url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

/** Strict on the alphabet: Node's base64 decoder silently drops invalid characters. */
export function decodeBase64Url(segment: string): string | null {
  if (!BASE64URL_SEGMENT.test(segment)) {
    return null;
  }
  return Buffer.from(segment, "base64url").toString("utf8");
}

export function hmacBase64Url(payloadJson: string, key: Uint8Array): string {
  return createHmac("sha256", key).update(payloadJson, "utf8").digest("base64url");
}

/**
 * Compares the base64url *text* of the provided signature with the expected one.
 * Length is checked first because `timingSafeEqual` throws on unequal buffers.
 */
export function signatureMatches(payloadJson: string, provided: string, key: Uint8Array): boolean {
  const expected = Buffer.from(hmacBase64Url(payloadJson, key), "utf8");
  const actual = Buffer.from(provided, "utf8");
  if (expected.length !== actual.length) {
    return false;
  }
  return timingSafeEqual(expected, actual);
}

/**
 * Builds `payloadJson` with the exact key order documented in the spec, so the
 * bytes that are signed are the bytes that are encoded into the token.
 */
function payloadJsonFor(claims: AttestationClaims, exp: number): string {
  return JSON.stringify({
    challengeId: claims.challengeId,
    score: claims.score,
    evidenceHash: claims.evidenceHash,
    exp,
  });
}

/**
 * Mints a token. Fails (typed, never throws) when the secret is unusable, when
 * the claims are malformed, or when the score is below the pass threshold — a
 * failing submission must not be convertible into a credential.
 */
export function signAttestation(
  claims: AttestationClaims,
  options?: { nowSeconds?: number; secret?: string },
): SignResult {
  const key = attestationKey(options?.secret);
  if (key === null) {
    return {
      ok: false,
      error: `${ATTESTATION_SECRET_ENV} is not configured with at least ${MIN_KEY_BYTES} bytes of key material`,
    };
  }

  const parsed = AttestationClaimsSchema.safeParse(claims);
  if (!parsed.success) {
    const paths = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    return { ok: false, error: `attestation claims are invalid (${paths})` };
  }

  if (parsed.data.score < PASS_THRESHOLD) {
    return { ok: false, error: "score is below the pass threshold; no attestation minted" };
  }

  const nowSeconds = options?.nowSeconds ?? Math.floor(Date.now() / 1000);
  const payloadJson = payloadJsonFor(parsed.data, nowSeconds + ATTESTATION_TTL_SECONDS);
  const token = `${encodeBase64Url(payloadJson)}.${hmacBase64Url(payloadJson, key)}`;
  return { ok: true, data: token };
}
