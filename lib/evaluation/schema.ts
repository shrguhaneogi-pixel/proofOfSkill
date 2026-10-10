/**
 * zod v4 schemas for the two untrusted boundaries of the evaluator:
 *
 * - `SubmissionSchema` — the body of `POST /api/evaluate` (api-schema.md →
 *   SUBMISSION). Its bounds live in `limits.ts`, which the client form imports
 *   too, so browser and server validate the same way by construction.
 * - `ModelEvaluationSchema` — the raw JSON a model is allowed to return
 *   (api-schema.md → EVALUATOR_CONTRACT).
 *
 * The model schema validates *shape only*. Bounds, pass/fail and score are the
 * job of `scoring.ts`, which is the trusted layer.
 */

import { z } from "zod";

import type { ChallengeId } from "../challenges/types";
import { CHALLENGE_ID_RANGE, CODE_RANGE, EXPLANATION_RANGE, REPO_URL_PATTERN } from "./limits";

/**
 * Mirrors api-schema.md → SUBMISSION. Two spelling changes, both forced by zod
 * 4.6: `z.int()` replaces the legacy `z.number().int()`, and `z.url()` replaces
 * the deprecated `z.string().url()`
 * (`node_modules/zod/v4/classic/schemas.d.ts:116`). Behaviour is identical, and
 * the numbers come from `limits.ts` so the client form cannot drift from them.
 */
/**
 * Shape only — `lib/solana/codecs.ts` `parsePublicKey` owns the authoritative decode, and
 * `/api/evaluate` runs every submission through it before minting an attestation. Keeping
 * the regex here means the browser form and the server reject the same obvious garbage
 * without pulling web3.js into the client bundle through this module.
 */
const WALLET_PUBLIC_KEY_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const SubmissionSchema = z.object({
  walletPublicKey: z.string().regex(WALLET_PUBLIC_KEY_PATTERN),
  challengeId: z.int().min(CHALLENGE_ID_RANGE.min).max(CHALLENGE_ID_RANGE.max),
  explanation: z.string().trim().min(EXPLANATION_RANGE.min).max(EXPLANATION_RANGE.max),
  code: z.string().trim().min(CODE_RANGE.min).max(CODE_RANGE.max),
  repoUrl: z.url().regex(REPO_URL_PATTERN).optional(),
});

export type Submission = {
  /** Base58 of the wallet that will own the credential, so the attestation is bound to it. */
  walletPublicKey: string;
  challengeId: ChallengeId;
  explanation: string;
  code: string;
  repoUrl?: string;
};

export const ModelCriterionSchema = z.object({
  id: z.string().min(1),
  /**
   * `z.number()` in zod 4 already rejects `NaN` and infinite values, so scoring
   * never has to reason about them arriving through this schema.
   */
  points: z.number(),
  comment: z.string(),
});

export const ModelEvaluationSchema = z.object({
  // Duplicates, missing ids and unknown ids are checked in `scoring.ts` so the
  // failure reason names the offending criterion instead of a generic refine.
  criteria: z.array(ModelCriterionSchema).min(1),
  strengths: z.array(z.string()),
  weaknesses: z.array(z.string()),
  feedback: z.string().min(1),
});

export type ModelEvaluation = z.infer<typeof ModelEvaluationSchema>;

/**
 * The result types live in `types.ts` alongside the transport interface. They are
 * not re-exported from here: one import path per type keeps a second alias from
 * drifting, and every consumer already reads them from `types.ts`.
 */

export type ValidationError = {
  ok: false;
  /** One short string per failing path, safe to show to a developer. */
  issues: string[];
};

export type SubmissionParseResult = { ok: true; data: Submission } | ValidationError;

export type ModelEvaluationParseResult = { ok: true; data: ModelEvaluation } | ValidationError;

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
}

function isChallengeId(value: number): value is ChallengeId {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5;
}

/**
 * Validates an unknown request body. Returns trimmed text fields, matching
 * `canonicalizeSubmission`, so the caller cannot hash a value that differs from
 * what was validated.
 */
export function parseSubmission(value: unknown): SubmissionParseResult {
  const parsed = SubmissionSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, issues: formatIssues(parsed.error) };
  }

  // The schema narrows to 1..5; this guard turns that into the ChallengeId
  // union without a cast, and fails loudly if the two definitions drift.
  if (!isChallengeId(parsed.data.challengeId)) {
    return { ok: false, issues: ["challengeId: outside the supported catalogue"] };
  }

  return {
    ok: true,
    data: {
      walletPublicKey: parsed.data.walletPublicKey,
      challengeId: parsed.data.challengeId,
      explanation: parsed.data.explanation,
      code: parsed.data.code,
      ...(parsed.data.repoUrl === undefined ? {} : { repoUrl: parsed.data.repoUrl }),
    },
  };
}

export function parseModelEvaluation(value: unknown): ModelEvaluationParseResult {
  const parsed = ModelEvaluationSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, issues: formatIssues(parsed.error) };
  }
  return { ok: true, data: parsed.data };
}
