/**
 * The AI evaluator (api-schema.md → EVALUATOR_CONTRACT).
 *
 * Contract with the rest of the app:
 * - `evaluateSubmission(challenge, submission, client, options, repoEvidence)`
 *   performs at most `MAX_ATTEMPTS` upstream calls, enforces its own deadline, and
 *   never trusts the model for a score, a total, or a pass — `scoring.ts` computes
 *   those. `repoEvidence` only changes what the model is shown and what the
 *   evidence hash commits to; it changes nothing about scoring.
 * - It reads no `process.env` and decides no configuration. The route handler
 *   owns env: it validates config and passes either `createOpenAIClient(config)`
 *   (see `openai-client.ts`) or the result of `evaluationWithoutApiKey(...)`
 *   (see `dev-fallback.ts`). Fetching a repository is the route's job too
 *   (`github.ts` `fetchRepositoryEvidence`); this module never reaches the network
 *   itself.
 * - It returns a typed outcome and never throws for a validation failure.
 * - It does **not** mint the attestation token: `lib/attestation` owns that. The
 *   field exists on `EvaluationResult` because the spec and the UI read it, but no
 *   code path here assigns it.
 */

import type { Challenge } from "../challenges/types";
import { canonicalizeSubmission } from "../hashing/canonicalize";
import { sha256EvidenceHash } from "../hashing/evidence-hash";
// Type-only: the evaluator must not acquire a dependency on octokit or on the
// network path, only on the shape of what the route already fetched.
import type { RepositoryEvidence } from "./github";
import { buildMessages, neutraliseDelimiters } from "./prompt";
import { parseModelEvaluation, type ModelEvaluation, type Submission } from "./schema";
import { scoreEvaluation } from "./scoring";
import {
  PASS_THRESHOLD,
  type ChatCompletionClient,
  type EvaluateOptions,
  type EvaluationFailure,
  type EvaluationOutcome,
  type EvaluatorRequestBody,
  type EvaluatorResponseBody,
} from "./types";
import { callWithinDeadline, classifyUpstreamError, sleep } from "./upstream-error";

/** Per-attempt wall clock budget (api-schema.md: "a timeout (e.g. 45 s)"). */
export const DEFAULT_TIMEOUT_MS = 45_000;
export const DEFAULT_RETRY_DELAY_MS = 1_000;

/**
 * Two attempts total for the whole call, whichever failure mode occurs. The spec
 * asks for "one retry for 429/5xx" and "reject and retry once" on invalid
 * output; one shared budget keeps the worst case at two paid requests and the
 * route's latency predictable.
 */
export const MAX_ATTEMPTS = 2;

/** api-schema.md requires temperature <= 0.2. Grading must be stable. */
export const TEMPERATURE = 0.15;

const MAX_REASON_CHARS = 120;
const UNUSABLE_RESPONSE = "the provider response was not a JSON object we could grade";

/**
 * Hex SHA-256 of the canonical submission; also needed by `/api/issue`.
 *
 * `repoDigest` is `RepositoryEvidence.digest` — the digest of the tree we actually
 * read. Omitting it (or passing an empty string) produces exactly the historical
 * preimage, so an evaluation with no fetched content hashes the same as one did
 * before repository inspection existed.
 */
export function buildEvidenceHash(submission: Submission, repoDigest?: string): Promise<string> {
  return sha256EvidenceHash(canonicalizeSubmission(submission), repoDigest);
}

/**
 * Some OpenAI-compatible gateways wrap JSON in prose or a fenced block. We accept
 * only the outermost object and let zod validate it: tolerance for the envelope,
 * never for the content.
 */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

function firstChoiceContent(response: EvaluatorResponseBody): string | undefined {
  const content = response.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : undefined;
}

/** Model-controlled text that re-enters the prompt on retry is still untrusted. */
function safeReasons(reasons: string[]): string[] {
  return reasons.map((reason) => {
    const neutral = neutraliseDelimiters(reason);
    return neutral.length > MAX_REASON_CHARS ? `${neutral.slice(0, MAX_REASON_CHARS)}…` : neutral;
  });
}

function invalidOutput(reason: string): EvaluationFailure {
  return {
    code: "AI_INVALID_OUTPUT",
    message: `The AI provider did not return grades matching this challenge's rubric. ${reason}`,
    retryable: false,
  };
}

function requestFor(
  challenge: Challenge,
  submission: Submission,
  client: ChatCompletionClient,
  repoEvidence: RepositoryEvidence | undefined,
  repairNote?: string[],
): EvaluatorRequestBody {
  return {
    model: client.model,
    messages: buildMessages(challenge, submission, {
      ...(repairNote === undefined ? {} : { repairNote }),
      ...(repoEvidence === undefined ? {} : { repoEvidence }),
    }),
    temperature: TEMPERATURE,
    response_format: { type: "json_object" },
  };
}

type Interpreted = { ok: true; raw: ModelEvaluation } | { ok: false; reasons: string[] };

/** Envelope check: is there a JSON object here that has the shape we demanded? */
function interpret(response: EvaluatorResponseBody): Interpreted {
  const text = firstChoiceContent(response);
  if (text === undefined) {
    return { ok: false, reasons: [UNUSABLE_RESPONSE] };
  }
  const json = extractJsonObject(text);
  if (json === undefined) {
    return { ok: false, reasons: ["the JSON in the provider response was malformed"] };
  }
  const validated = parseModelEvaluation(json);
  if (!validated.ok) {
    return { ok: false, reasons: validated.issues };
  }
  return { ok: true, raw: validated.data };
}

/**
 * `repoEvidence` is a trailing optional argument rather than a field of
 * `EvaluateOptions` so the call sites that already exist — and every test stub —
 * keep compiling unchanged. It is display and commitment only: the bytes are shown
 * to the model, and its digest joins the evidence hash. Score, `passed`, and the
 * retry budget are computed exactly as they were without it, by `scoring.ts`, from
 * server-side weights.
 */
export async function evaluateSubmission(
  challenge: Challenge,
  submission: Submission,
  client: ChatCompletionClient,
  options: EvaluateOptions = {},
  repoEvidence?: RepositoryEvidence,
): Promise<EvaluationOutcome> {
  if (client.model.trim() === "") {
    return {
      ok: false,
      error: { code: "AI_NOT_CONFIGURED", message: "AI_MODEL is not set to a model id.", retryable: false },
    };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const evidenceHash = await buildEvidenceHash(submission, repoEvidence?.digest);

  let repairNote: string[] | undefined;
  let lastReason = UNUSABLE_RESPONSE;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const body = requestFor(challenge, submission, client, repoEvidence, repairNote);

    let response: EvaluatorResponseBody;
    try {
      response = await callWithinDeadline(client, body, timeoutMs);
    } catch (error) {
      const classified = classifyUpstreamError(error);
      if (classified.retryable && attempt < MAX_ATTEMPTS) {
        repairNote = undefined;
        await sleep(retryDelayMs * attempt);
        continue;
      }
      return { ok: false, error: classified };
    }

    const interpreted = interpret(response);
    if (!interpreted.ok) {
      const reasons = safeReasons(interpreted.reasons);
      lastReason = reasons[0] ?? UNUSABLE_RESPONSE;
      if (attempt < MAX_ATTEMPTS) {
        repairNote = reasons;
        await sleep(retryDelayMs * attempt);
        continue;
      }
      return { ok: false, error: invalidOutput(lastReason) };
    }

    const scored = scoreEvaluation(challenge, interpreted.raw);
    if (!scored.ok) {
      if (scored.error.code === "rubric_invalid") {
        // A broken rubric is a repo bug: a second model call cannot change it.
        return {
          ok: false,
          error: {
            code: "AI_NOT_CONFIGURED",
            message: `Challenge ${challenge.id} is misconfigured and cannot be graded.`,
            retryable: false,
          },
        };
      }
      const reasons = safeReasons(scored.error.reasons);
      lastReason = reasons[0] ?? UNUSABLE_RESPONSE;
      if (attempt < MAX_ATTEMPTS) {
        repairNote = reasons;
        await sleep(retryDelayMs * attempt);
        continue;
      }
      return { ok: false, error: invalidOutput(lastReason) };
    }

    return {
      ok: true,
      data: {
        challengeId: challenge.id,
        score: scored.data.score,
        passed: scored.data.passed,
        passThreshold: PASS_THRESHOLD,
        strengths: scored.data.strengths,
        weaknesses: scored.data.weaknesses,
        feedback: scored.data.feedback,
        evaluatedCriteria: scored.data.evaluatedCriteria,
        evidenceHash,
        provider: client.model,
        evaluatedAt: new Date().toISOString(),
      },
    };
  }

  // Unreachable while every attempt path returns or continues, but the loop bound
  // is a constant the compiler cannot prove exhaustive. Keeps the function total
  // if MAX_ATTEMPTS is raised or a branch later gains a `continue`.
  return { ok: false, error: invalidOutput(lastReason) };
}
