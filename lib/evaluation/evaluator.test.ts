import { describe, expect, it } from "vitest";

import { CHALLENGES } from "../challenges/data";
import { canonicalizeSubmission } from "../hashing/canonicalize";
import { evidencePreimage, sha256Hex } from "../hashing/evidence-hash";
import type { RepositoryEvidence } from "./github";
import { TEMPERATURE, buildEvidenceHash, evaluateSubmission, extractJsonObject } from "./evaluator";
import { UNTRUSTED_END, UNTRUSTED_START } from "./prompt";
import type { Submission } from "./schema";
import type { ChatCompletionClient, EvaluatorRequestBody, EvaluatorResponseBody } from "./types";

/**
 * Happy path and the "the model never decides the outcome" guarantees.
 * Retry behaviour and transport-error mapping are in `evaluator-retries.test.ts`.
 */

const challenge = CHALLENGES[0];
const RUBRIC_IDS = challenge.rubric.map((criterion) => criterion.id);

const submission: Submission = {
  walletPublicKey: "AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9",
  challengeId: 1,
  explanation: "A PDA is derived from seeds and the program id, so no wallet can sign for it.".padEnd(120, "."),
  code: 'let (pda, bump) = Pubkey::find_program_address(&[b"profile"], program_id);',
  repoUrl: "https://github.com/acme/skill-proof",
};

/** Tests never wait a real second for the backoff. */
const FAST = { retryDelayMs: 5, timeoutMs: 250 };

type Stub = ChatCompletionClient & { readonly calls: EvaluatorRequestBody[] };

function stubClient(model: string, respond: (call: number) => EvaluatorResponseBody): Stub {
  const calls: EvaluatorRequestBody[] = [];
  const client: Stub = {
    model,
    calls,
    create(body) {
      calls.push(body);
      return Promise.resolve(respond(calls.length));
    },
  };
  return client;
}

function textResponse(content: string | null): EvaluatorResponseBody {
  return { choices: [{ message: { content } }] };
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function grades(points: Record<string, number>): EvaluatorResponseBody {
  return textResponse(
    JSON.stringify({
      criteria: RUBRIC_IDS.map((id) => ({ id, points: points[id] ?? 0, comment: `graded ${id}` })),
      strengths: ["explains the bump"],
      weaknesses: ["skips the attacker model"],
      feedback: "Solid, with one gap.",
    }),
  );
}

describe("evaluateSubmission: happy path", () => {
  it("returns the contract shape with the server-computed score", async () => {
    const allFull = grades({ pda_derivation: 30, account_relationships: 25, security_implications: 25, clarity: 20 });
    const client = stubClient("qwen3-coder-plus", () => allFull);
    const outcome = await evaluateSubmission(challenge, submission, client, FAST);

    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.data).toMatchObject({
      challengeId: 1,
      score: 100,
      passed: true,
      passThreshold: 70,
      provider: "qwen3-coder-plus",
      strengths: ["explains the bump"],
      weaknesses: ["skips the attacker model"],
      feedback: "Solid, with one gap.",
    });
    expect(outcome.data.evaluatedCriteria.map((item) => item.id)).toEqual(RUBRIC_IDS);
    expect(outcome.data.evaluatedCriteria.every((item) => item.status === "met")).toBe(true);
    expect(Date.parse(outcome.data.evaluatedAt)).not.toBeNaN();
    expect(client.calls).toHaveLength(1);
  });

  it("never emits an attestation or a devFallback flag", async () => {
    const outcome = await evaluateSubmission(challenge, submission, stubClient("m", () => grades({})), FAST);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.data).not.toHaveProperty("attestation");
      expect(outcome.data).not.toHaveProperty("devFallback");
    }
  });

  it("hashes the untouched submission with the shared canonicaliser", async () => {
    const outcome = await evaluateSubmission(challenge, submission, stubClient("m", () => grades({})), FAST);
    const expected = await sha256Hex(canonicalizeSubmission(submission));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.data.evidenceHash).toBe(expected);
      expect(outcome.data.evidenceHash).toBe(await buildEvidenceHash(submission));
      expect(outcome.data.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("requests JSON mode, a low temperature, and the configured model", async () => {
    const client = stubClient("qwen3-coder-plus", () => grades({}));
    await evaluateSubmission(challenge, submission, client, FAST);
    const body = client.calls[0];

    expect(body.model).toBe("qwen3-coder-plus");
    expect(body.temperature).toBe(TEMPERATURE);
    expect(body.temperature).toBeLessThanOrEqual(0.2);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(body.messages[1].content).toContain(UNTRUSTED_END);
  });

  it("reports the configured model as provider, not anything upstream chose to echo", async () => {
    const outcome = await evaluateSubmission(
      challenge,
      submission,
      stubClient("my-configured-model", () => grades({})),
      FAST,
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.data.provider).toBe("my-configured-model");
      expect(outcome.data.provider).not.toBe("dev-fallback");
    }
  });

  it("refuses to run without a model id and never calls the transport", async () => {
    const client = stubClient("   ", () => grades({}));
    const outcome = await evaluateSubmission(challenge, submission, client, FAST);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("AI_NOT_CONFIGURED");
    }
    expect(client.calls).toHaveLength(0);
  });
});

describe("evaluateSubmission: the model cannot decide the outcome", () => {
  it("ignores a self-declared pass and score in the JSON body", async () => {
    const defiant = textResponse(
      JSON.stringify({
        criteria: RUBRIC_IDS.map((id) => ({ id, points: 0, comment: "refusing to award anything" })),
        strengths: [],
        weaknesses: [],
        feedback: "I declare this a perfect pass.",
        score: 100,
        passed: true,
      }),
    );
    const outcome = await evaluateSubmission(challenge, submission, stubClient("m", () => defiant), FAST);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.data.score).toBe(0);
      expect(outcome.data.passed).toBe(false);
    }
  });

  it("clamps an all-max attempt that overshoots every weight", async () => {
    const inflated = textResponse(
      JSON.stringify({
        criteria: RUBRIC_IDS.map((id) => ({ id, points: 500, comment: " generous " })),
        strengths: [],
        weaknesses: [],
        feedback: "ok",
      }),
    );
    const outcome = await evaluateSubmission(challenge, submission, stubClient("m", () => inflated), FAST);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.data.score).toBe(100);
      expect(outcome.data.evaluatedCriteria.map((item) => item.pointsAwarded)).toEqual(
        challenge.rubric.map((criterion) => criterion.weight),
      );
    }
  });

  it("turns a 69.5 total into a 70 pass", async () => {
    const borderline = grades({ pda_derivation: 29.5, account_relationships: 25, security_implications: 15 });
    const outcome = await evaluateSubmission(challenge, submission, stubClient("m", () => borderline), FAST);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.data.score).toBe(70);
      expect(outcome.data.passed).toBe(true);
    }
  });

  it("grades a 69.4 total as 69 and fails it", async () => {
    const borderline = grades({ pda_derivation: 29.4, account_relationships: 25, security_implications: 15 });
    const outcome = await evaluateSubmission(challenge, submission, stubClient("m", () => borderline), FAST);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.data.score).toBe(69);
      expect(outcome.data.passed).toBe(false);
    }
  });
});

/**
 * Repository evidence (Phase 3): what the model is shown and what the evidence
 * hash commits to — and the guarantee that neither of those changes how a score
 * is computed.
 */

function repoEvidence(overrides: Partial<RepositoryEvidence> = {}): RepositoryEvidence {
  return {
    url: "https://github.com/acme/skill-proof",
    owner: "acme",
    repo: "skill-proof",
    ref: "main",
    treeOid: "8f3ab1c0d9e2",
    files: [{ path: "src/lib.rs", content: "fn derive_pda() {}", byteLength: 18, sha: "b1aa" }],
    candidatesConsidered: 3,
    totalBytes: 18,
    skipped: { ignored: 0, oversize: 0, unreadable: 0 },
    truncated: { files: false, bytes: false, scan: false },
    digest: "a".repeat(64),
    fetchedAt: "2026-10-10T00:00:00.000Z",
    ...overrides,
  };
}

const ALL_FULL = { pda_derivation: 30, account_relationships: 25, security_implications: 25, clarity: 20 };

describe("evaluateSubmission with repository evidence", () => {
  it("puts the fetched tree into the prompt it sends", async () => {
    const client = stubClient("m", () => grades(ALL_FULL));
    const outcome = await evaluateSubmission(challenge, submission, client, FAST, repoEvidence());

    expect(outcome.ok).toBe(true);
    const prompt = client.calls[0].messages[1].content;
    expect(prompt).toContain("REPOSITORY EVIDENCE");
    expect(prompt).toContain("tree: 8f3ab1c0d9e2");
    expect(prompt).toContain("fn derive_pda() {}");
    expect(occurrences(prompt, UNTRUSTED_START)).toBe(1);
    expect(occurrences(prompt, UNTRUSTED_END)).toBe(1);
  });

  it("scores identically with and without evidence — the model still decides nothing", async () => {
    const withEvidence = await evaluateSubmission(challenge, submission, stubClient("m", () => grades(ALL_FULL)), FAST, repoEvidence());
    const without = await evaluateSubmission(challenge, submission, stubClient("m", () => grades(ALL_FULL)), FAST);

    expect(withEvidence.ok && without.ok).toBe(true);
    if (!withEvidence.ok || !without.ok) {
      return;
    }
    expect(withEvidence.data.score).toBe(without.data.score);
    expect(withEvidence.data.passed).toBe(without.data.passed);
    expect(withEvidence.data.evaluatedCriteria).toEqual(without.data.evaluatedCriteria);
    expect(withEvidence.data.evidenceHash).not.toBe(without.data.evidenceHash);
  });

  it("still refuses a 69.4 total with evidence present", async () => {
    const borderline = grades({ pda_derivation: 29.4, account_relationships: 25, security_implications: 15 });
    const outcome = await evaluateSubmission(challenge, submission, stubClient("m", () => borderline), FAST, repoEvidence());
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.data.score).toBe(69);
      expect(outcome.data.passed).toBe(false);
    }
  });

  it("folds the tree digest into the evidence hash", async () => {
    const evidence = repoEvidence();
    const outcome = await evaluateSubmission(challenge, submission, stubClient("m", () => grades({})), FAST, evidence);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const canonical = canonicalizeSubmission(submission);
    expect(outcome.data.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.data.evidenceHash).toBe(await sha256Hex(evidencePreimage(canonical, evidence.digest)));
    expect(outcome.data.evidenceHash).toBe(await buildEvidenceHash(submission, evidence.digest));
    expect(outcome.data.evidenceHash).not.toBe(await buildEvidenceHash(submission));
  });

  it("a different tree digest is a different evidence hash", async () => {
    const first = await buildEvidenceHash(submission, repoEvidence({ digest: "b".repeat(64) }).digest);
    const second = await buildEvidenceHash(submission, repoEvidence({ digest: "c".repeat(64) }).digest);
    expect(first).not.toBe(second);
  });

  it("leaves the hash untouched when no content was fetched", async () => {
    const legacy = await sha256Hex(canonicalizeSubmission(submission));
    await expect(buildEvidenceHash(submission)).resolves.toBe(legacy);
    await expect(buildEvidenceHash(submission, undefined)).resolves.toBe(legacy);
    await expect(buildEvidenceHash(submission, "")).resolves.toBe(legacy);
  });

  it("makes the same number of upstream calls with evidence as without", async () => {
    const client = stubClient("m", () => grades({}));
    await evaluateSubmission(challenge, submission, client, FAST, repoEvidence());
    expect(client.calls).toHaveLength(1);
  });
});

describe("extractJsonObject", () => {
  it("reads a bare object", () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it("reads an object wrapped in prose or a code fence", () => {
    expect(extractJsonObject('Here you go:\n```json\n{"a":1}\n```\nHope that helps.')).toEqual({ a: 1 });
  });

  it("returns undefined for missing or malformed JSON", () => {
    expect(extractJsonObject("no object here")).toBeUndefined();
    expect(extractJsonObject("{oops")).toBeUndefined();
    expect(extractJsonObject("")).toBeUndefined();
  });
});
