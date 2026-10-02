import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// `server-only` resolves to a throwing stub outside a React Server bundler, so
// it is stubbed here; production still gets the real guard.
vi.mock("server-only", () => ({ default: {} }));

import {
  PASS_THRESHOLD,
  attestationKey,
  encodeBase64Url,
  hmacBase64Url,
  signAttestation,
  type AttestationClaims,
  type AttestationPayload,
} from "./sign";
import { verifyAttestation, type AttestationRejectionCode, type VerifyResult } from "./verify";

const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OTHER_SECRET = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

const EVIDENCE_HASH = "63c446cf82ccd52235e415b7f3de9969f75459676cd0fbb1e44041e339152b77";
const claims: AttestationClaims = { challengeId: 1, score: 87, evidenceHash: EVIDENCE_HASH };

const NOW_SECONDS = 1_760_000_000;
const TTL = 15 * 60;

const payload: AttestationPayload = {
  challengeId: 1,
  score: 87,
  evidenceHash: EVIDENCE_HASH,
  exp: NOW_SECONDS + TTL,
};

/** Mints through the real signer. */
function mint(overrides?: Partial<AttestationClaims>, secret?: string): string {
  const result = signAttestation(
    { ...claims, ...overrides },
    { nowSeconds: NOW_SECONDS, ...(secret === undefined ? {} : { secret }) },
  );
  if (!result.ok) {
    throw new Error(`attestation should have been minted: ${result.error}`);
  }
  return result.data;
}

/** Signs a payload the real signer would refuse to mint, to exercise the verifier alone. */
function forge(body: AttestationPayload, secret = SECRET): string {
  const payloadJson = JSON.stringify(body);
  return `${encodeBase64Url(payloadJson)}.${hmacFor(payloadJson, secret)}`;
}

function hmacFor(payloadJson: string, secret = SECRET): string {
  const key = attestationKey(secret);
  if (key === null) {
    throw new Error("test secret should decode");
  }
  return hmacBase64Url(payloadJson, key);
}

/** Narrows the typed union: the tests below assert *which* reason came back. */
function rejection(result: VerifyResult, label: string): AttestationRejectionCode {
  if (result.ok) {
    throw new Error(`expected a rejection for ${label}`);
  }
  expect(result.error.length).toBeGreaterThan(0);
  return result.code;
}

function accepted(result: VerifyResult, label: string): AttestationPayload {
  if (!result.ok) {
    throw new Error(`expected acceptance for ${label}: ${result.code}`);
  }
  return result.data;
}

function verify(token: string, nowSeconds = NOW_SECONDS): VerifyResult {
  return verifyAttestation(token, { nowSeconds });
}

describe("verifyAttestation", () => {
  const previousSecret = process.env.ATTESTATION_SECRET;

  beforeAll(() => {
    process.env.ATTESTATION_SECRET = SECRET;
  });

  afterAll(() => {
    if (previousSecret === undefined) {
      delete process.env.ATTESTATION_SECRET;
    } else {
      process.env.ATTESTATION_SECRET = previousSecret;
    }
  });

  it("accepts a token the signer just minted and returns its claims", () => {
    expect(accepted(verify(mint()), "round trip")).toEqual(payload);
  });

  it("accepts right up to the last second of the window and rejects after it", () => {
    const token = mint();
    expect(accepted(verify(token, NOW_SECONDS + TTL - 1), "just before expiry").exp).toBe(
      NOW_SECONDS + TTL,
    );
    expect(rejection(verify(token, NOW_SECONDS + TTL), "at expiry")).toBe("expired");
  });

  it("rejects an expired token", () => {
    expect(rejection(verify(mint(), NOW_SECONDS + TTL + 1), "expired")).toBe("expired");
  });

  it("rejects a tampered payload that keeps the original signature", () => {
    const [, signatureSegment] = mint().split(".");
    // Same key order the signer emits, with only the score changed.
    const tamperedJson = JSON.stringify({ ...payload, score: 100 });
    const token = `${encodeBase64Url(tamperedJson)}.${signatureSegment}`;
    expect(token).not.toBe(mint());
    expect(rejection(verify(token), "tampered payload")).toBe("invalid_signature");
  });

  it("rejects a tampered signature", () => {
    const [payloadSegment, signatureSegment] = mint().split(".");
    const flipped = (signatureSegment[0] === "A" ? "B" : "A") + signatureSegment.slice(1);
    expect(rejection(verify(`${payloadSegment}.${flipped}`), "tampered signature")).toBe(
      "invalid_signature",
    );
  });

  it("rejects a truncated signature instead of throwing on the length mismatch", () => {
    const [payloadSegment] = mint().split(".");
    expect(rejection(verify(`${payloadSegment}.QUVD`), "short signature")).toBe(
      "invalid_signature",
    );
  });

  it("rejects a below-threshold score that was signed with the real key", () => {
    const signed = forge({ ...payload, score: PASS_THRESHOLD - 1 });
    expect(signAttestation({ ...claims, score: PASS_THRESHOLD - 1 }).ok).toBe(false);
    expect(rejection(verify(signed), "below threshold")).toBe("below_threshold");
  });

  it("accepts exactly the threshold score", () => {
    expect(accepted(verify(forge({ ...payload, score: PASS_THRESHOLD })), "at threshold").score).toBe(
      PASS_THRESHOLD,
    );
  });

  it("rejects a token signed with another secret", () => {
    expect(rejection(verify(mint(undefined, OTHER_SECRET)), "foreign secret")).toBe(
      "invalid_signature",
    );
  });

  it("rejects malformed input of every shape", () => {
    const malformed: unknown[] = [
      "",
      "no-dot-here",
      `${encodeBase64Url("{}")}.${encodeBase64Url("sig")}.extra`,
      "!!not-base64url.####",
      "cGF5bG9hZA.",
      ".",
      "a.",
      undefined,
      null,
      42,
      {},
      [mint()],
      true,
    ];
    for (const value of malformed) {
      const result = verifyAttestation(value, { nowSeconds: NOW_SECONDS });
      expect(rejection(result, `malformed ${String(value)}`)).toBe("malformed");
    }
  });

  it("rejects a correctly signed payload that is not the documented shape", () => {
    const notJson = `${encodeBase64Url("plain text, not json")}.${hmacFor("plain text, not json")}`;
    expect(rejection(verify(notJson), "not json")).toBe("malformed");

    const missingField = JSON.stringify({ challengeId: 1, score: 90, exp: NOW_SECONDS + TTL });
    expect(rejection(verify(`${encodeBase64Url(missingField)}.${hmacFor(missingField)}`), "no hash")).toBe(
      "malformed",
    );

    const badHash = JSON.stringify({ ...payload, evidenceHash: "zz" });
    expect(rejection(verify(`${encodeBase64Url(badHash)}.${hmacFor(badHash)}`), "bad hash")).toBe(
      "malformed",
    );

    const wrongType = JSON.stringify({ ...payload, challengeId: "6" });
    expect(
      rejection(verify(`${encodeBase64Url(wrongType)}.${hmacFor(wrongType)}`), "string id"),
    ).toBe("malformed");
  });

  it("checks the signature before trusting the payload", () => {
    const [payloadSegment] = forge({ ...payload, exp: NOW_SECONDS + 10 * TTL }).split(".");
    expect(rejection(verify(`${payloadSegment}.${"A".repeat(43)}`), "unsigned future token")).toBe(
      "invalid_signature",
    );
  });

  it("reports a missing secret separately from a bad token", () => {
    const token = mint(undefined, SECRET);
    delete process.env.ATTESTATION_SECRET;
    try {
      expect(rejection(verify(token), "no secret configured")).toBe("secret_missing");
    } finally {
      process.env.ATTESTATION_SECRET = SECRET;
    }
  });

  it("never echoes token or secret material back in a rejection", () => {
    const token = mint();
    const cases: readonly [VerifyResult, AttestationRejectionCode][] = [
      [verify(`${token.slice(0, -4)}AAAA`), "invalid_signature"],
      [verify("garbage"), "malformed"],
      [verify(token, NOW_SECONDS + TTL * 2), "expired"],
      [verify(forge({ ...payload, score: PASS_THRESHOLD - 1 })), "below_threshold"],
      [
        verifyAttestation(token, { nowSeconds: NOW_SECONDS, secret: OTHER_SECRET }),
        "invalid_signature",
      ],
    ];
    for (const [result, expectedCode] of cases) {
      expect(rejection(result, expectedCode)).toBe(expectedCode);
      // Narrow the union again so the assertions below read the failure branch.
      if (result.ok) {
        throw new Error(`expected a rejection for ${expectedCode}`);
      }
      expect(result.error).not.toContain(token);
      expect(result.error).not.toContain(SECRET);
      expect(result.error).not.toContain(OTHER_SECRET);
    }
  });
});
