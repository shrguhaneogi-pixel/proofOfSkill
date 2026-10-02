/**
 * Types for the AI evaluation boundary (`docs/api-schema.md` →
 * EVALUATOR_CONTRACT).
 *
 * Nothing in this folder reads `process.env` at import time and nothing calls
 * the network at import time: the transport is injected, so the deterministic
 * parts (schema, prompt, scoring) are unit-testable without a live endpoint.
 */

import type { ChallengeId } from "../challenges/types";
import { PASS_THRESHOLD } from "../program-contract";

// The passing bar is fixed by the program, not by the model or this service, so it is imported
// from the module that mirrors the onchain constants rather than restated here.
export { PASS_THRESHOLD };

/**
 * Stable error codes for a failed evaluation. `docs/api-schema.md` → ROUTES
 * maps them to HTTP status: AI_NOT_CONFIGURED 503, AI_INVALID_OUTPUT 502,
 * AI_TIMEOUT 504, AI_UPSTREAM_ERROR 502.
 */
export type EvaluationErrorCode =
  | "AI_NOT_CONFIGURED"
  | "AI_INVALID_OUTPUT"
  | "AI_TIMEOUT"
  | "AI_UPSTREAM_ERROR";

export type EvaluationFailure = {
  code: EvaluationErrorCode;
  /** User-safe. Never contains env values or the raw upstream response body. */
  message: string;
  /**
   * Whether the caller may try again later. Upstream 429/5xx and timeouts are
   * transient; a rejected API key or a model that keeps emitting unusable JSON
   * is not.
   */
  retryable: boolean;
};

export type EvaluationOutcome =
  | { ok: true; data: EvaluationResult }
  | { ok: false; error: EvaluationFailure };

export type CriterionStatus = "met" | "partial" | "not_met";

export type EvaluatedCriterion = {
  id: string;
  label: string;
  weight: number;
  pointsAwarded: number;
  status: CriterionStatus;
  comment: string;
};

/**
 * Shape returned to the client. `attestation` is owned by the route handler and
 * `lib/attestation`, so it is deliberately absent here: this module must not be
 * able to mint its own authorisation.
 */
export type EvaluationResult = {
  challengeId: ChallengeId;
  score: number;
  passed: boolean;
  passThreshold: typeof PASS_THRESHOLD;
  strengths: string[];
  weaknesses: string[];
  feedback: string;
  evaluatedCriteria: EvaluatedCriterion[];
  /** hex SHA-256 of the canonical submission, from `lib/hashing`. */
  evidenceHash: string;
  /** Real model id, or the literal "dev-fallback". */
  provider: string;
  evaluatedAt: string;
  /**
   * Present only on results produced by the development fallback, so the UI can
   * render the "Development fallback — not an AI evaluation" banner without
   * re-parsing `provider`.
   */
  devFallback?: true;
  /**
   * Declared because api-schema.md puts it on `EvaluationResult`, so the UI and
   * the route can read it — but nothing in `lib/evaluation` ever sets it. The
   * route handler mints it via `lib/attestation`, and only when `passed` is true
   * and `canMintAttestation(result)` holds. Keeping it optional here means the
   * evaluator cannot authorise its own credential.
   */
  attestation?: string;
};

/* ------------------------------------------------------------------ *
 * Injectable transport
 * ------------------------------------------------------------------ */

export type EvaluatorSystemMessage = { role: "system"; content: string };

export type EvaluatorUserMessage = { role: "user"; content: string };

/**
 * A discriminated union rather than `{ role: EvaluatorMessageRole }` so the
 * adapter in `openai-client.ts` can assign straight onto the SDK's
 * `ChatCompletionMessageParam` union, which keys each member on a literal role.
 */
export type EvaluatorRequestMessage = EvaluatorSystemMessage | EvaluatorUserMessage;

/**
 * Wire names (`response_format`, not `responseFormat`) because this is a 1:1
 * description of the OpenAI-compatible chat completions body. Keeping the
 * upstream spelling makes the adapter in `openai-client.ts` a trivial passthrough
 * and keeps exactly what we asked the model for auditable in one place.
 */
export type EvaluatorRequestBody = {
  model: string;
  messages: EvaluatorRequestMessage[];
  temperature: number;
  response_format: { type: "json_object" };
};

export type EvaluatorResponseBody = {
  choices: { message: { content: string | null } }[];
};

/**
 * The whole network surface of this module. Tests pass a stub;
 * `createOpenAIClient` builds the real one from caller-supplied config.
 *
 * `model` is the id this client is bound to and is surfaced as
 * `EvaluationResult.provider`, so a stub can prove the field reflects
 * configuration rather than anything the upstream chose to echo back.
 */
export type ChatCompletionClient = {
  readonly model: string;
  create(body: EvaluatorRequestBody): Promise<EvaluatorResponseBody>;
};

export type EvaluateOptions = {
  /** Per-attempt deadline. Defaults to `DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Base backoff before the single retry. Defaults to `DEFAULT_RETRY_DELAY_MS`. */
  retryDelayMs?: number;
};
