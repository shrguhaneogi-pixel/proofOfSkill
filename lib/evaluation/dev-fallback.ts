/**
 * Development fallback (docs/rules.md → FORBIDDEN_PRACTICES: "No mock AI output
 * presented as real").
 *
 * WHAT THIS IS: a placeholder result returned by the route when no `AI_API_KEY`
 * is configured and `NODE_ENV === "development"`, so the UI can be built without
 * spending API credits. It performs **no AI evaluation at all** — no model is
 * called, no reasoning happens. It is not a heuristic grader and it is not a
 * sample answer.
 *
 * WHAT IT AWARDS: zero points on every criterion, `passed: false`, and feedback
 * that says it was not evaluated. Deliberately unwinnable: a passing dev-fallback
 * sample would be a fabricated grade, and the temptation to route one into a
 * credential is exactly what this file exists to prevent.
 *
 * WHY AN ATTESTATION IS IMPOSSIBLE FROM IT — three independent guards:
 * 1. `provider` is the literal `"dev-fallback"`; api-schema.md allows an
 *    `attestation` on a result only when `passed` and `provider` is not
 *    dev-fallback (`canMintAttestation` below is that rule).
 * 2. `passed` is always `false`, so the first half of that condition fails too.
 * 3. This module refuses to build the result when `NODE_ENV === "production"`
 *    and returns the `AI_NOT_CONFIGURED` error instead — so in production the
 *    dev-fallback object cannot exist to be attested.
 */

import type { Challenge } from "../challenges/types";
import { canonicalizeSubmission } from "../hashing/canonicalize";
import { sha256Hex } from "../hashing/evidence-hash";
import type { Submission } from "./schema";
import { PASS_THRESHOLD, type EvaluationOutcome, type EvaluationResult } from "./types";

export const DEV_FALLBACK_PROVIDER = "dev-fallback";

export const SETUP_INSTRUCTIONS =
  "Set AI_API_KEY (and, for an OpenAI-compatible gateway, AI_BASE_URL and AI_MODEL) in .env.local — copy .env.example and fill the server-only section — then restart the dev server.";

/** True only for a real Next.js/Node development process. */
export function isDevelopmentEnv(nodeEnv: string | undefined): boolean {
  return nodeEnv === "development";
}

/**
 * Reads the flag this module sets, so callers never have to string-compare the
 * provider and a non-fallback result can never accidentally carry it.
 */
export function isDevFallback(result: EvaluationResult): boolean {
  return result.devFallback === true || result.provider === DEV_FALLBACK_PROVIDER;
}

/**
 * The gate the route handler must apply before calling `lib/attestation`.
 * Exported here because "dev-fallback can never be attested" is this module's
 * guarantee; keeping the rule in one place keeps it enforceable.
 */
export function canMintAttestation(result: EvaluationResult): boolean {
  return result.passed && !isDevFallback(result);
}

function notConfigured(): EvaluationOutcome {
  return {
    ok: false,
    error: {
      code: "AI_NOT_CONFIGURED",
      message: `No AI provider key is configured, and no evaluation was performed. ${SETUP_INSTRUCTIONS}`,
      retryable: false,
    },
  };
}

/**
 * Builds the labelled placeholder, or the configuration error when the caller is
 * not in development. `nodeEnv` is passed in — this module never reads
 * `process.env`.
 */
export async function evaluationWithoutApiKey(
  challenge: Challenge,
  submission: Submission,
  nodeEnv: string | undefined,
): Promise<EvaluationOutcome> {
  if (!isDevelopmentEnv(nodeEnv)) {
    return notConfigured();
  }

  const evidenceHash = await sha256Hex(canonicalizeSubmission(submission));

  return {
    ok: true,
    data: {
      challengeId: challenge.id,
      score: 0,
      passed: false,
      passThreshold: PASS_THRESHOLD,
      strengths: [],
      weaknesses: [
        "Not evaluated: this result came from the development fallback, not from an AI evaluation.",
      ],
      feedback: `Development fallback — not an AI evaluation. ${SETUP_INSTRUCTIONS}`,
      evaluatedCriteria: challenge.rubric.map((criterion) => ({
        id: criterion.id,
        label: criterion.label,
        weight: criterion.weight,
        pointsAwarded: 0,
        status: "not_met" as const,
        comment: "Not evaluated: no AI provider key is configured in this development environment.",
      })),
      evidenceHash,
      provider: DEV_FALLBACK_PROVIDER,
      evaluatedAt: new Date().toISOString(),
      devFallback: true,
    },
  };
}
