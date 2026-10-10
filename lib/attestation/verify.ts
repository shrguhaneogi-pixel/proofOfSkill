/**
 * Verifies an attestation token before `/api/issue` will co-sign a credential.
 *
 * Rejection reasons are machine-readable so a route can map them to a wire code
 * (`400 INVALID_ATTESTATION`, or `503` when the server itself is unconfigured)
 * through `lib/errors/mapping.ts`. Nothing about the token's contents is echoed
 * back to the caller.
 *
 * Server-only: verification needs `ATTESTATION_SECRET`.
 */
import "server-only";

import {
  AttestationPayloadSchema,
  PASS_THRESHOLD,
  attestationKey,
  decodeBase64Url,
  signatureMatches,
  type AttestationPayload,
} from "./sign";

export type AttestationRejectionCode =
  | "invalid_signature"
  | "expired"
  | "below_threshold"
  | "wallet_mismatch"
  | "malformed"
  | "secret_missing";

export type VerifyResult =
  | { ok: true; data: AttestationPayload }
  | { ok: false; code: AttestationRejectionCode; error: string };

export type VerifyOptions = {
  nowSeconds?: number;
  secret?: string;
  /**
   * The wallet the caller is acting as, canonical base58. When supplied, a token
   * minted for any other wallet is rejected: without it a stolen or forwarded
   * attestation could be redeemed by whoever held it.
   */
  expectedWalletPublicKey?: string;
};

const TOKEN_PART_COUNT = 2;

/** Fixed text per reason: the reason is the contract, the message is for logs. */
const REJECTION_TEXT: Record<AttestationRejectionCode, string> = {
  invalid_signature: "attestation signature does not match",
  expired: "attestation is past its expiry",
  below_threshold: "attestation score is below the pass threshold",
  wallet_mismatch: "attestation was minted for a different wallet",
  malformed: "attestation is not a well-formed token",
  secret_missing: "attestation secret is not configured",
};

function reject(code: AttestationRejectionCode): VerifyResult {
  return { ok: false, code, error: REJECTION_TEXT[code] };
}

/**
 * Order matters: the signature is checked before anything is read from the
 * payload, so an unauthenticated body can never influence a later decision.
 * The payload bytes that were signed are verified as-received (never
 * re-serialized), which is what makes the token tamper-evident.
 */
export function verifyAttestation(
  token: unknown,
  options?: VerifyOptions,
): VerifyResult {
  if (typeof token !== "string" || token.length === 0) {
    return reject("malformed");
  }

  const parts = token.split(".");
  if (parts.length !== TOKEN_PART_COUNT) {
    return reject("malformed");
  }

  const [payloadSegment, signatureSegment] = parts;
  const payloadJson = decodeBase64Url(payloadSegment);
  if (payloadJson === null || decodeBase64Url(signatureSegment) === null) {
    return reject("malformed");
  }

  const key = attestationKey(options?.secret);
  if (key === null) {
    return reject("secret_missing");
  }

  if (!signatureMatches(payloadJson, signatureSegment, key)) {
    return reject("invalid_signature");
  }

  const parsed = parsePayload(payloadJson);
  if (parsed === null) {
    return reject("malformed");
  }

  // Only a body whose signature already verified can reach this comparison, so the
  // claimed wallet is trustworthy; it is the *caller-supplied* one that is not.
  if (
    options?.expectedWalletPublicKey !== undefined &&
    parsed.walletPublicKey !== options.expectedWalletPublicKey
  ) {
    return reject("wallet_mismatch");
  }

  const nowSeconds = options?.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (parsed.exp <= nowSeconds) {
    return reject("expired");
  }

  // Defence in depth: the threshold is also enforced when the token is minted.
  if (parsed.score < PASS_THRESHOLD) {
    return reject("below_threshold");
  }

  return { ok: true, data: parsed };
}

function parsePayload(payloadJson: string): AttestationPayload | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  const parsed = AttestationPayloadSchema.safeParse(decoded);
  return parsed.success ? parsed.data : null;
}
