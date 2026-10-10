import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// `server-only` resolves to a throwing stub outside a React Server bundler, so
// it is stubbed here; production still gets the real guard.
vi.mock("server-only", () => ({ default: {} }));

import {
  ATTESTATION_TTL_SECONDS,
  ATTESTATION_VERSION,
  PASS_THRESHOLD,
  decodeBase64Url,
  keyBytesFromMaterial,
  signAttestation,
  type AttestationClaims,
} from "./sign";

// 64 hex chars = 32 bytes of key material. Test-only value.
const TEST_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// Real SHA-256 digests reused from lib/hashing/canonicalize.test.ts.
const EVIDENCE_HASH = "63c446cf82ccd52235e415b7f3de9969f75459676cd0fbb1e44041e339152b77";
const OTHER_EVIDENCE_HASH = "f704cac90d02c7d0ce98e984efa5c2a42999e2a6a31c74ec3c308e090ebc9763";

// Two real ed25519 addresses (seeds of all 0x01 and all 0x02), so the wallet
// binding is exercised against values that pass the address-shape check.
const WALLET_A = "AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9";

const claims: AttestationClaims = {
  walletPublicKey: WALLET_A,
  challengeId: 1,
  score: 87,
  evidenceHash: EVIDENCE_HASH,
};

const NOW_SECONDS = 1_760_000_000;

function signedAttestation(overrides?: Partial<AttestationClaims>): string {
  const result = signAttestation({ ...claims, ...overrides }, { nowSeconds: NOW_SECONDS });
  if (!result.ok) {
    throw new Error(`attestation should have been minted: ${result.error}`);
  }
  return result.data;
}

describe("signAttestation", () => {
  const previousSecret = process.env.ATTESTATION_SECRET;

  beforeAll(() => {
    process.env.ATTESTATION_SECRET = TEST_SECRET;
  });

  afterAll(() => {
    if (previousSecret === undefined) {
      delete process.env.ATTESTATION_SECRET;
    } else {
      process.env.ATTESTATION_SECRET = previousSecret;
    }
  });

  it("emits base64url payload, a dot, then base64url signature", () => {
    const token = signedAttestation();
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("writes the payload keys in the documented order", () => {
    const [payloadSegment] = signedAttestation().split(".");
    const payloadJson = decodeBase64Url(payloadSegment);
    expect(payloadJson).not.toBeNull();
    expect(Object.keys(JSON.parse(payloadJson ?? "{}")).join(",")).toBe(
      "v,walletPublicKey,challengeId,score,evidenceHash,exp",
    );
  });

  it("stamps the version so a format change retires older tokens", () => {
    const [payloadSegment] = signedAttestation().split(".");
    const payload = JSON.parse(decodeBase64Url(payloadSegment) ?? "{}");
    expect(payload.v).toBe(ATTESTATION_VERSION);
  });

  it("carries the wallet it was minted for, and differs when the wallet differs", () => {
    const [payloadSegment] = signedAttestation().split(".");
    const payload = JSON.parse(decodeBase64Url(payloadSegment) ?? "{}");
    expect(payload.walletPublicKey).toBe(WALLET_A);

    const otherWallet = signedAttestation({ walletPublicKey: "9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu" });
    expect(otherWallet).not.toBe(signedAttestation());
  });

  it("refuses to mint for an address that is not a Solana public key", () => {
    for (const wallet of ["", "not-an-address", "0OIl+==", "a".repeat(31), "0OIl".repeat(12)]) {
      const result = signAttestation({ ...claims, walletPublicKey: wallet });
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error(`expected refusal for ${JSON.stringify(wallet)}`);
      }
      expect(result.error).toContain("walletPublicKey");
    }
  });

  it("sets exp to the pass threshold-free fifteen minute window", () => {
    const [payloadSegment] = signedAttestation().split(".");
    const payload = JSON.parse(decodeBase64Url(payloadSegment) ?? "{}");
    expect(payload.exp).toBe(NOW_SECONDS + ATTESTATION_TTL_SECONDS);
    expect(ATTESTATION_TTL_SECONDS).toBe(15 * 60);
    expect(PASS_THRESHOLD).toBe(70);
  });

  it("is deterministic for identical claims and clock", () => {
    expect(signedAttestation()).toBe(signedAttestation());
  });

  it("produces a different token for every different payload", () => {
    const byChallenge = signedAttestation({ challengeId: 2 });
    const byScore = signedAttestation({ score: 91 });
    const byHash = signedAttestation({ evidenceHash: OTHER_EVIDENCE_HASH });
    const tokens = new Set([signedAttestation(), byChallenge, byScore, byHash]);
    expect(tokens.size).toBe(4);
  });

  it("refuses to mint an attestation below the pass threshold", () => {
    const result = signAttestation({ ...claims, score: PASS_THRESHOLD - 1 });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected refusal");
    }
    expect(result.error).toContain("threshold");
    expect(result.error).not.toContain(String(PASS_THRESHOLD - 1));
  });

  it("rejects claims that are not part of the contract", () => {
    const result = signAttestation({ ...claims, score: 140 });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected refusal");
    }
    expect(result.error).toContain("score");
  });

  it("fails instead of throwing when the secret is absent", () => {
    delete process.env.ATTESTATION_SECRET;
    const result = signAttestation(claims);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected refusal");
    }
    expect(result.error).toContain("ATTESTATION_SECRET");
  });

  it("names the missing key without ever echoing secret material", () => {
    process.env.ATTESTATION_SECRET = "short-secret";
    const result = signAttestation(claims);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected refusal");
    }
    expect(result.error).toContain("ATTESTATION_SECRET");
    expect(result.error).not.toContain("short-secret");
  });
});

describe("keyBytesFromMaterial", () => {
  it("reads hex, base64 and plain text material alike", () => {
    const hex = keyBytesFromMaterial("ab".repeat(32));
    const base64 = keyBytesFromMaterial(Buffer.alloc(32, 7).toString("base64"));
    const text = keyBytesFromMaterial("correct horse battery staple aaaa");
    expect(hex?.length).toBe(32);
    expect(base64?.length).toBe(32);
    expect(text?.length).toBe(33);
  });

  it("rejects material that decodes below the minimum", () => {
    expect(keyBytesFromMaterial("")).toBeNull();
    expect(keyBytesFromMaterial("010203")).toBeNull();
    expect(keyBytesFromMaterial("a".repeat(16))).toBeNull();
  });

  it("is stable for the same input", () => {
    const first = keyBytesFromMaterial(TEST_SECRET);
    const second = keyBytesFromMaterial(TEST_SECRET);
    expect(Array.from(first ?? [])).toEqual(Array.from(second ?? []));
  });
});
