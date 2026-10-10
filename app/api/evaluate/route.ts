import { NextResponse } from "next/server";

import { findChallenge } from "@/lib/challenges/data";
import { parseEnv } from "@/lib/env.server";
import { canMintAttestation, evaluationWithoutApiKey } from "@/lib/evaluation/dev-fallback";
import { evaluateSubmission } from "@/lib/evaluation/evaluator";
import {
  createOctokitGitHubClient,
  fetchRepositoryEvidence,
  type GitHubApiClient,
  type RepositoryEvidence,
} from "@/lib/evaluation/github";
import { createOpenAIClient } from "@/lib/evaluation/openai-client";
import { SubmissionSchema } from "@/lib/evaluation/schema";
import type { EvaluationErrorCode } from "@/lib/evaluation/types";
import { signAttestation } from "@/lib/attestation/sign";
import { bytesToHex } from "@/lib/hashing/evidence-hash";
import { parsePublicKey } from "@/lib/solana/codecs";
import { parseUpstashConfig, createRateLimiterWithFallback, clientKey } from "@/lib/rate-limit";

export const runtime = "nodejs";

/** Submissions are bounded by the schema, so anything larger is noise. */
const MAX_BODY_BYTES = 20_000;

// Resolved on the first `check()`, not at import: `next build` evaluates this module with an
// empty environment, and freezing the choice there would pin every runtime request to whatever
// the build machine happened to have. Without the Upstash pair this is the same in-process
// fixed window as before, and `describe()` says which one is live.
const limiter = createRateLimiterWithFallback({
  windowMs: 10 * 60 * 1000,
  maxRequests: 8,
  upstash: () => {
    const config = parseUpstashConfig();
    return config.ok ? config.config : null;
  },
});

const STATUS_BY_CODE: Record<EvaluationErrorCode, number> = {
  AI_NOT_CONFIGURED: 503,
  AI_INVALID_OUTPUT: 502,
  AI_TIMEOUT: 504,
  AI_UPSTREAM_ERROR: 502,
};

function fail(status: number, code: string, message: string, headers?: HeadersInit) {
  return NextResponse.json({ error: { code, message } }, { status, headers });
}

/**
 * Lazily built so the token is read on the first request, never at import: `next build`
 * evaluates this module with an empty environment and must not capture that. An unset
 * token is not an error — evidence is simply skipped, which is the pre-Phase-3 behaviour.
 */
let githubClient: GitHubApiClient | null = null;

async function collectRepoEvidence(repoUrl: string | undefined): Promise<RepositoryEvidence | undefined> {
  if (!repoUrl) {
    return undefined;
  }
  githubClient ??= createOctokitGitHubClient({ token: process.env.GITHUB_TOKEN });
  if (!githubClient.authenticated) {
    console.error("GITHUB_TOKEN is not set; grading this submission from its text only");
    return undefined;
  }

  const evidence = await fetchRepositoryEvidence(repoUrl, { client: githubClient });
  if (!evidence.ok) {
    // Deliberately not surfaced to the caller as a failure: the code, not the repo, is
    // what was submitted. Logged so an operator can tell "no evidence" from "no repo".
    console.error(`repository evidence skipped (${evidence.error.code}) for the submitted repoUrl`);
    return undefined;
  }
  return evidence.data;
}

export async function POST(request: Request) {
  // A Redis read cannot be synchronous, so the limiter's `check` is awaited.
  const limit = await limiter.check(clientKey(request.headers));
  if (!limit.ok) {
    if (limit.decline === "redis-outage") {
      // Nobody is over budget here — the counter itself was unreachable, so every caller
      // is being declined. 503 and a log line, rather than blaming this user for our
      // dependency, which is what a 429 would do.
      console.error(`rate limiter unavailable, declining request: ${limit.cause}`);
      return fail(
        503,
        "RATE_LIMITED",
        "Evaluation is not accepting requests at the moment. Try again shortly.",
        { "retry-after": String(limit.retryAfterSeconds) },
      );
    }
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

  // The attestation is bound to this address, so the credential a later `/api/issue`
  // co-signs can only land in the wallet that was evaluated. Canonicalised through
  // `parsePublicKey` and re-emitted as base58 so a non-canonical spelling in the body
  // cannot produce a token that fails to match on redemption.
  const wallet = parsePublicKey(parsed.data.walletPublicKey);
  if (!wallet.ok) {
    return fail(400, "INVALID_WALLET", "That wallet address is not a valid Solana public key.");
  }
  const walletPublicKey = wallet.data.toBase58();

  // `challenge.id` carries the literal union the evaluator requires. The lookup
  // above already proved the submitted id resolves to a real challenge, so this
  // narrows the type without changing the value.
  const submission = { ...parsed.data, challengeId: challenge.id, walletPublicKey };

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
        undefined,
        // Fetched here rather than inside `lib/evaluation` so the evaluator stays free of
        // network access, and so a repo that cannot be fetched degrades to grading the
        // submitted text instead of failing the user's submission.
        await collectRepoEvidence(submission.repoUrl),
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

  // A dev-fallback result scores 0, so canMintAttestation() rejects it and nothing
  // here can turn a non-evaluation into an issuable pass.
  if (canMintAttestation(result)) {
    const signed = signAttestation(
      {
        walletPublicKey: submission.walletPublicKey,
        challengeId: result.challengeId,
        score: result.score,
        evidenceHash: result.evidenceHash,
      },
      // Passed explicitly from the already-validated env rather than letting the
      // signer read `process.env` itself, so there is one validation path. The
      // decoded key bytes are re-encoded as hex, which round-trips identically.
      { secret: bytesToHex(env.attestationKeyBytes) },
    );

    if (signed.ok) {
      body.attestation = signed.data;
    } else {
      // Without this the user just sees "Pass · not issuable" and no operator
      // trace exists. The message names the offending key, never its value.
      console.error(`attestation minting failed for challenge ${result.challengeId}: ${signed.error}`);
    }
  }

  return NextResponse.json(body);
}
