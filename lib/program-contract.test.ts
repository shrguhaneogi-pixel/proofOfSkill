import { describe, expect, it, vi } from "vitest";

// `lib/attestation/sign.ts` is server-only; the package throws unless it is loaded under the
// react-server condition, which vitest's node environment does not provide.
vi.mock("server-only", () => ({ default: {} }));

import { MAX_SCORE as ATTESTATION_MAX_SCORE, PASS_THRESHOLD as ATTESTATION_THRESHOLD } from "./attestation/sign";
import { PASS_THRESHOLD as EVALUATION_THRESHOLD } from "./evaluation/types";
import {
  MAX_CHALLENGE_ID as SOLANA_MAX_CHALLENGE_ID,
  MAX_SCORE as SOLANA_MAX_SCORE,
  MIN_CHALLENGE_ID as SOLANA_MIN_CHALLENGE_ID,
  PASS_THRESHOLD as SOLANA_THRESHOLD,
} from "./solana/constants";
import { MAX_CHALLENGE_ID, MAX_SCORE, MIN_CHALLENGE_ID, PASS_THRESHOLD } from "./program-contract";

/**
 * These literals are the values asserted by the Rust test module in
 * `programs/proof_of_skill/src/constants.rs`. If the program's constants ever move, this test
 * fails first — which is the point: a server that mints attestations above a threshold the chain
 * rejects produces passes that silently cannot be issued.
 */
describe("program contract constants", () => {
  it("match the values the onchain program enforces", () => {
    expect(MIN_CHALLENGE_ID).toBe(1);
    expect(MAX_CHALLENGE_ID).toBe(5);
    expect(MAX_SCORE).toBe(100);
    expect(PASS_THRESHOLD).toBe(70);
  });

  it("keep the pass threshold inside the issuable score range", () => {
    expect(PASS_THRESHOLD).toBeLessThanOrEqual(MAX_SCORE);
    expect(PASS_THRESHOLD).toBeGreaterThan(0);
  });

  it("are one source, not three copies that can drift", () => {
    expect(SOLANA_THRESHOLD).toBe(PASS_THRESHOLD);
    expect(ATTESTATION_THRESHOLD).toBe(PASS_THRESHOLD);
    expect(EVALUATION_THRESHOLD).toBe(PASS_THRESHOLD);

    expect(SOLANA_MAX_SCORE).toBe(MAX_SCORE);
    expect(ATTESTATION_MAX_SCORE).toBe(MAX_SCORE);

    expect(SOLANA_MIN_CHALLENGE_ID).toBe(MIN_CHALLENGE_ID);
    expect(SOLANA_MAX_CHALLENGE_ID).toBe(MAX_CHALLENGE_ID);
  });

  it("agree with the challenge ids the catalogue exposes", async () => {
    const { CHALLENGE_IDS } = await import("./challenges/types");
    expect(CHALLENGE_IDS[0]).toBe(MIN_CHALLENGE_ID);
    expect(CHALLENGE_IDS[CHALLENGE_IDS.length - 1]).toBe(MAX_CHALLENGE_ID);
  });
});
