import { describe, expect, it } from "vitest";

import { REPO_URL_PATTERN } from "./limits";
import { parseModelEvaluation, parseSubmission, SubmissionSchema } from "./schema";

const TEXT_99 = "a".repeat(99);
const TEXT_100 = "a".repeat(100);
const LONG_ENOUGH = "p".repeat(120);

function validBody(overrides: Record<string, unknown> = {}) {
  return { challengeId: 1, explanation: TEXT_100, code: "fn main() {}", ...overrides };
}

describe("SubmissionSchema", () => {
  it("accepts a well-formed submission", () => {
    const result = parseSubmission(validBody({ repoUrl: "https://github.com/acme/skill-proof" }));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) {
      expect(result.data.challengeId).toBe(1);
    }
  });

  it("measures the explanation after trimming, so padding cannot reach 100 characters", () => {
    // Raw length 104, trimmed length 99. If zod checked min() before trim() this
    // would pass, and the value we hash would be a 99 character explanation.
    const result = parseSubmission(validBody({ explanation: `${TEXT_99}     ` }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join(" ")).toContain("explanation");
    }
  });

  it("accepts exactly 100 characters and rejects 4001", () => {
    expect(parseSubmission(validBody({ explanation: TEXT_100 })).ok).toBe(true);
    expect(parseSubmission(validBody({ explanation: "a".repeat(4001) })).ok).toBe(false);
  });

  it("rejects challenge ids outside the five-item catalogue", () => {
    for (const challengeId of [0, 6, 1.5, Number.NaN, "1"]) {
      expect(parseSubmission(validBody({ challengeId })).ok, `id ${String(challengeId)}`).toBe(false);
    }
  });

  it("rejects blank code", () => {
    expect(parseSubmission(validBody({ code: "   " })).ok).toBe(false);
  });

  it("accepts a missing repo url and one with a trailing slash", () => {
    expect(parseSubmission(validBody()).ok).toBe(true);
    const withRepo = parseSubmission(validBody({ repoUrl: "https://github.com/acme/skill-proof/" }));
    expect(withRepo.ok, JSON.stringify(withRepo)).toBe(true);
  });

  it("rejects any repoUrl that is not an https github owner/repo", () => {
    for (const repoUrl of [
      "http://github.com/acme/repo",
      "https://gitlab.com/acme/repo",
      "https://github.com/acme/repo/extra",
      "not a url",
      "https://github.com/acme",
      "https://evil.example/?u=https://github.com/acme/repo",
    ]) {
      expect(parseSubmission(validBody({ repoUrl })).ok, repoUrl).toBe(false);
    }
  });

  it("accepts only the shared github repo pattern", () => {
    expect(REPO_URL_PATTERN.test("https://github.com/acme/repo")).toBe(true);
    expect(REPO_URL_PATTERN.test("https://github.com/acme/repo/issues/1")).toBe(false);
  });

  it("omits repoUrl from the parsed object when absent, so the hash input is stable", () => {
    const parsed = SubmissionSchema.safeParse({ challengeId: 2, explanation: LONG_ENOUGH, code: "x" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect("repoUrl" in parsed.data).toBe(false);
    }
  });

  it("drops repoUrl from the returned value rather than setting it undefined", () => {
    const result = parseSubmission(validBody());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.hasOwn(result.data, "repoUrl")).toBe(false);
    }
  });
});

describe("parseModelEvaluation", () => {
  const good = {
    criteria: [{ id: "clarity", points: 18, comment: "well written" }],
    strengths: ["clear"],
    weaknesses: [],
    feedback: "good",
  };

  it("accepts the contract shape", () => {
    const result = parseModelEvaluation(good);
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  it("rejects an empty criteria list", () => {
    expect(parseModelEvaluation({ ...good, criteria: [] }).ok).toBe(false);
  });

  it("rejects NaN and infinite points", () => {
    for (const points of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "18", null]) {
      const result = parseModelEvaluation({ ...good, criteria: [{ id: "clarity", points, comment: "" }] });
      expect(result.ok, `points ${String(points)}`).toBe(false);
    }
  });

  it("rejects blank feedback and non-string list entries", () => {
    expect(parseModelEvaluation({ ...good, feedback: "" }).ok).toBe(false);
    expect(parseModelEvaluation({ ...good, strengths: [1] }).ok).toBe(false);
  });

  it("strips extra keys, so a model that self-declares a pass cannot smuggle one", () => {
    const result = parseModelEvaluation({ ...good, passed: true, score: 100 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).not.toHaveProperty("passed");
    }
  });

  it("reports the failing path so a developer can see what the model got wrong", () => {
    const result = parseModelEvaluation({ ...good, criteria: [{ id: "", points: 1, comment: 2 }] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join(" ")).toContain("criteria.0.id");
    }
  });
});
