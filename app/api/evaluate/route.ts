import { NextResponse } from "next/server";

import { findChallenge } from "@/lib/challenges/data";
import { parseEnv } from "@/lib/env.server";
import { canMintAttestation, evaluationWithoutApiKey } from "@/lib/evaluation/dev-fallback";
import { evaluateSubmission } from "@/lib/evaluation/evaluator";
import { createOpenAIClient } from "@/lib/evaluation/openai-client";
import { SubmissionSchema } from "@/lib/evaluation/schema";
import type { EvaluationErrorCode } from "@/lib/evaluation/types";
import { signAttestation } from "@/lib/attestation/sign";
import { bytesToHex } from "@/lib/hashing/evidence-hash";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";

export const runtime = "nodejs";

/** Submissions are bounded by the schema, so anything larger is noise. */
const MAX_BODY_BYTES = 20_000;

const limiter = createRateLimiter({ windowMs: 10 * 60 * 1000, maxRequests: 8 });

const STATUS_BY_CODE: Record<EvaluationErrorCode, number> = {
  AI_NOT_CONFIGURED: 503,
  AI_INVALID_OUTPUT: 502,
  AI_TIMEOUT: 504,
  AI_UPSTREAM_ERROR: 502,
};

function fail(status: number, code: string, message: string, headers?: HeadersInit) {
  return NextResponse.json({ error: { code, message } }, { status, headers });
}

export async function POST(request: Request) {
  const limit = limiter.check(clientKey(request.headers));
  if (!limit.ok) {
    return fail(
      429,
      "RATE_LIMITED",
      `Too many evaluations from this address. Try again in ${limit.retryAfterSeconds} seconds.`,
      { "retry-after": String(limit.retryAfterSeconds) },
    );
  }

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return fail(413, "INVALID_SUBMISSION", "That submission is too large to evaluate.");
  }

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    return fail(413, "INVALID_SUBMISSION", "That submission is too large to evaluate.");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail(400, "INVALID_SUBMISSION", "Request body must be JSON.");
  }

  const parsed = SubmissionSchema.safeParse(raw);
  if (!parsed.success) {
    const paths = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    return fail(
      400,
      "INVALID_SUBMISSION",
      `The submission is incomplete or too short. Check these fields: ${paths}.`,
    );
  }

  const challenge = findChallenge(parsed.data.challengeId);
  if (!challenge) {
    return fail(404, "CHALLENGE_NOT_FOUND", "No challenge exists with that id.");
  }

  // `challenge.id` carries the literal union the evaluator requires. The lookup
  // above already proved the submitted id resolves to a real challenge, so this
  // narrows the type without changing the value.
  const submission = { ...parsed.data, challengeId: challenge.id };

  const envResult = parseEnv();
  if (!envResult.ok) {
    // Never echo env validation text to the browser: it names configured keys.
    return fail(500, "SERVER_MISCONFIGURED", "The server is not configured correctly.");
  }
  const env = envResult.data;

  const outcome = env.ai
    ? await evaluateSubmission(
        challenge,
        submission,
        createOpenAIClient({
          apiKey: env.ai.apiKey,
          baseURL: env.ai.baseUrl,
          model: env.ai.model,
        }),
      )
    : await evaluationWithoutApiKey(challenge, submission, process.env.NODE_ENV);

  if (!outcome.ok) {
    return fail(
      STATUS_BY_CODE[outcome.error.code],
      outcome.error.code,
      outcome.error.message,
      outcome.error.retryable ? { "retry-after": "30" } : undefined,
    );
  }

  const result = outcome.data;
  const body: typeof result & { attestation?: string } = { ...result };

  // The fallback reports a pass-shaped object never reaches here: it scores 0.
  // Everything above this line is what makes "passed" a server-side fact.
  if (canMintAttestation(result)) {
    const signed = signAttestation(
      {
        challengeId: result.challengeId,
        score: result.score,
        evidenceHash: result.evidenceHash,
      },
      // `signAttestation` takes key material; env already holds decoded bytes.
      // Re-encoding as hex round-trips to the identical key.
      { secret: bytesToHex(env.attestationKeyBytes) },
    );
    if (signed.ok) {
      body.attestation = signed.data;
    }
  }

  return NextResponse.json(body);
}
