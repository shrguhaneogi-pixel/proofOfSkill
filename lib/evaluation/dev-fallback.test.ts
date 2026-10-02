import { describe, expect, it } from "vitest";

import { CHALLENGES } from "../challenges/data";
import { canonicalizeSubmission } from "../hashing/canonicalize";
import { sha256Hex } from "../hashing/evidence-hash";
import {
  DEV_FALLBACK_PROVIDER,
  SETUP_INSTRUCTIONS,
  canMintAttestation,
  evaluationWithoutApiKey,
  isDevFallback,
  isDevelopmentEnv,
} from "./dev-fallback";
import type { Submission } from "./schema";
import { PASS_THRESHOLD, type EvaluationResult } from "./types";

const challenge = CHALLENGES[0];

const submission: Submission = {
  challengeId: 1,
  explanation: "A PDA is derived from seeds and the program id, so it has no private key.".padEnd(120, "."),
  code: 'let (pda, bump) = Pubkey::find_program_address(&[b"profile"], program_id);',
};

function realResult(overrides: Partial<EvaluationResult> = {}): EvaluationResult {
  return {
    challengeId: 1,
    score: 82,
    passed: true,
    passThreshold: PASS_THRESHOLD,
    strengths: [],
    weaknesses: [],
    feedback: "good",
    evaluatedCriteria: [],
    evidenceHash: "ab".repeat(32),
    provider: "qwen3-coder-plus",
    evaluatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe("isDevelopmentEnv", () => {
  it("accepts only an explicit development environment", () => {
    expect(isDevelopmentEnv("development")).toBe(true);
    expect(isDevelopmentEnv("production")).toBe(false);
    expect(isDevelopmentEnv("test")).toBe(false);
    expect(isDevelopmentEnv(undefined)).toBe(false);
    expect(isDevelopmentEnv("Development")).toBe(false);
  });
});

describe("the development fallback", () => {
  it("is clearly labelled and never presented as an AI evaluation", async () => {
    const outcome = await evaluationWithoutApiKey(challenge, submission, "development");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.data.provider).toBe(DEV_FALLBACK_PROVIDER);
    expect(outcome.data.devFallback).toBe(true);
    expect(outcome.data.feedback).toContain("not an AI evaluation");
    expect(outcome.data.weaknesses.join(" ")).toContain("development fallback");
  });

  it("awards nothing, so it cannot pass", async () => {
    const outcome = await evaluationWithoutApiKey(challenge, submission, "development");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.data.score).toBe(0);
    expect(outcome.data.passed).toBe(false);
    expect(outcome.data.passThreshold).toBe(70);
    expect(outcome.data.evaluatedCriteria).toHaveLength(challenge.rubric.length);
    for (const criterion of outcome.data.evaluatedCriteria) {
      expect(criterion).toMatchObject({ pointsAwarded: 0, status: "not_met" });
      expect(criterion.comment).toContain("Not evaluated");
    }
  });

  it("still carries a real evidence hash for the submission it describes", async () => {
    const outcome = await evaluationWithoutApiKey(challenge, submission, "development");
    const expected = await sha256Hex(canonicalizeSubmission(submission));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.data.evidenceHash).toBe(expected);
    }
  });

  it("refuses to exist outside development", async () => {
    for (const nodeEnv of ["production", "test", undefined, ""] as const) {
      const outcome = await evaluationWithoutApiKey(challenge, submission, nodeEnv);
      expect(outcome.ok, `NODE_ENV=${String(nodeEnv)}`).toBe(false);
      if (!outcome.ok) {
        expect(outcome.error.code).toBe("AI_NOT_CONFIGURED");
        expect(outcome.error.retryable).toBe(false);
      }
    }
  });

  it("gives the operator the setup path instead of a fake grade", async () => {
    const outcome = await evaluationWithoutApiKey(challenge, submission, "production");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.message).toContain(SETUP_INSTRUCTIONS);
      expect(outcome.error.message).toContain(".env.local");
    }
  });
});

describe("canMintAttestation", () => {
  it("allows a real passing evaluation", () => {
    expect(canMintAttestation(realResult())).toBe(true);
  });

  it("blocks a failing evaluation", () => {
    expect(canMintAttestation(realResult({ passed: false, score: 41 }))).toBe(false);
  });

  it("blocks the fallback even if something forced passed to true", async () => {
    const outcome = await evaluationWithoutApiKey(challenge, submission, "development");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const forged: EvaluationResult = { ...outcome.data, passed: true, score: 100 };
    expect(isDevFallback(forged)).toBe(true);
    expect(canMintAttestation(forged)).toBe(false);
  });

  it("detects the fallback by provider alone, without the flag", () => {
    expect(isDevFallback(realResult({ provider: DEV_FALLBACK_PROVIDER }))).toBe(true);
  });

  it("never lets a result claiming the fallback provider be attested", () => {
    expect(canMintAttestation(realResult({ provider: DEV_FALLBACK_PROVIDER }))).toBe(false);
  });

  it("leaves a real evaluation without the devFallback flag", () => {
    expect(realResult().devFallback).toBeUndefined();
    expect(isDevFallback(realResult())).toBe(false);
  });
});
