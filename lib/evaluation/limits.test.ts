import { describe, expect, it } from "vitest";

import { CODE_RANGE, CHALLENGE_ID_RANGE, EXPLANATION_RANGE, REPO_URL_PATTERN } from "./limits";
import { SubmissionSchema, parseSubmission } from "./schema";

/**
 * These numbers are copied from docs/api-schema.md → SUBMISSION. If a value
 * changes here, the spec and the onchain evidence hash inputs changed too — this
 * test exists to make that a deliberate edit rather than a typo.
 */
describe("limits.ts matches docs/api-schema.md", () => {
  it("pins the explanation window", () => {
    expect(EXPLANATION_RANGE).toEqual({ min: 100, max: 4000 });
  });

  it("pins the code window", () => {
    expect(CODE_RANGE).toEqual({ min: 1, max: 8000 });
  });

  it("pins the repository pattern", () => {
    expect(REPO_URL_PATTERN.source).toBe(String.raw`^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$`);
  });

  it("pins the challenge id window to the five-item catalogue", () => {
    expect(CHALLENGE_ID_RANGE).toEqual({ min: 1, max: 5 });
  });

  it("drives the server schema, so a bound change cannot be applied to one side only", () => {
    const explanation = SubmissionSchema.shape.explanation;
    expect(explanation.minLength).toBe(EXPLANATION_RANGE.min);
    expect(explanation.maxLength).toBe(EXPLANATION_RANGE.max);

    const code = SubmissionSchema.shape.code;
    expect(code.minLength).toBe(CODE_RANGE.min);
    expect(code.maxLength).toBe(CODE_RANGE.max);
  });

  it("rejects exactly at each boundary", () => {
    const base = { challengeId: 1, code: "x" };
    const atMin = "a".repeat(EXPLANATION_RANGE.min);
    const belowMin = "a".repeat(EXPLANATION_RANGE.min - 1);
    const aboveMax = "a".repeat(EXPLANATION_RANGE.max + 1);

    expect(parseSubmission({ ...base, explanation: atMin }).ok).toBe(true);
    expect(parseSubmission({ ...base, explanation: belowMin }).ok).toBe(false);
    expect(parseSubmission({ ...base, explanation: aboveMax }).ok).toBe(false);
    expect(parseSubmission({ ...base, explanation: atMin, code: "" }).ok).toBe(false);
  });
});
