import { describe, expect, it } from "vitest";

import { CHALLENGES } from "../challenges/data";
import type { Challenge } from "../challenges/types";
import type { ModelEvaluation } from "./schema";
import { clampPoints, criterionStatus, scoreEvaluation } from "./scoring";

/** Challenge 1: pda_derivation 30, account_relationships 25, security_implications 25, clarity 20. */
const challenge = CHALLENGES[0];
const RUBRIC_IDS = challenge.rubric.map((criterion) => criterion.id);

function grades(points: Record<string, number>, overrides: Partial<ModelEvaluation> = {}): ModelEvaluation {
  return {
    criteria: challenge.rubric.map((criterion) => ({
      id: criterion.id,
      points: points[criterion.id] ?? 0,
      comment: `graded ${criterion.id}`,
    })),
    strengths: ["explains the bump"],
    weaknesses: ["skips the attacker model"],
    feedback: "A competent answer with one gap.",
    ...overrides,
  };
}

function expectFailure(result: ReturnType<typeof scoreEvaluation>) {
  expect(result.ok, JSON.stringify(result)).toBe(false);
  if (result.ok) {
    throw new Error("expected a scoring failure");
  }
  return result.error;
}

describe("clampPoints", () => {
  it("clamps above the weight and below zero", () => {
    expect(clampPoints(99, 25)).toBe(25);
    expect(clampPoints(-99, 25)).toBe(0);
    expect(clampPoints(0, 25)).toBe(0);
    expect(clampPoints(25, 25)).toBe(25);
  });

  it("passes fractional points through, because only the total is rounded", () => {
    expect(clampPoints(12.5, 25)).toBe(12.5);
  });

  it("reduces non-finite numbers to zero rather than to full marks", () => {
    // An infinite or NaN grade is garbage input. Clamping it to `weight` would
    // hand the candidate a full score for a malformed answer, so it goes to 0.
    expect(clampPoints(Number.NaN, 25)).toBe(0);
    expect(clampPoints(Number.POSITIVE_INFINITY, 25)).toBe(0);
    expect(clampPoints(Number.NEGATIVE_INFINITY, 25)).toBe(0);
  });
});

describe("criterionStatus", () => {
  it("treats exactly 80% of the weight as met", () => {
    expect(criterionStatus(20, 25)).toBe("met");
    expect(criterionStatus(24, 30)).toBe("met");
    expect(criterionStatus(16, 20)).toBe("met");
  });

  it("treats just under 80% as partial, and exactly 40% as partial", () => {
    expect(criterionStatus(19.9, 25)).toBe("partial");
    expect(criterionStatus(10, 25)).toBe("partial");
    expect(criterionStatus(12, 30)).toBe("partial");
  });

  it("treats just under 40% as not_met", () => {
    expect(criterionStatus(9.9, 25)).toBe("not_met");
    expect(criterionStatus(0, 25)).toBe("not_met");
    expect(criterionStatus(11.9, 30)).toBe("not_met");
  });
});

describe("scoreEvaluation", () => {
  it("awards a perfect 100 and passes", () => {
    const result = scoreEvaluation(
      challenge,
      grades({ pda_derivation: 30, account_relationships: 25, security_implications: 25, clarity: 20 }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.score).toBe(100);
      expect(result.data.passed).toBe(true);
      expect(result.data.passThreshold).toBe(70);
      expect(result.data.evaluatedCriteria.map((item) => item.status)).toEqual([
        "met",
        "met",
        "met",
        "met",
      ]);
    }
  });

  it("awards a hard zero and fails", () => {
    const result = scoreEvaluation(challenge, grades({}));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.score).toBe(0);
      expect(result.data.passed).toBe(false);
      expect(result.data.evaluatedCriteria.every((item) => item.status === "not_met")).toBe(true);
      expect(result.data.evaluatedCriteria.every((item) => item.pointsAwarded === 0)).toBe(true);
    }
  });

  it("clamps out-of-range grades and reports the server's own labels and weights", () => {
    // 500 clamps to the 30 weight, -5 clamps to 0: 30 + 0 + 25 + 20 = 75.
    const result = scoreEvaluation(
      challenge,
      grades({ pda_derivation: 500, account_relationships: -5, security_implications: 25, clarity: 20 }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.score).toBe(75);
      expect(result.data.passed).toBe(true);
      expect(result.data.evaluatedCriteria[0]).toMatchObject({
        id: "pda_derivation",
        label: "PDA derivation mechanics",
        weight: 30,
        pointsAwarded: 30,
        status: "met",
      });
      expect(result.data.evaluatedCriteria[1]).toMatchObject({ pointsAwarded: 0, status: "not_met" });
    }
  });

  it("keeps the rubric's own order no matter how the model ordered its answer", () => {
    const shuffled = grades({});
    shuffled.criteria = [...shuffled.criteria].reverse();
    const result = scoreEvaluation(challenge, shuffled);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.evaluatedCriteria.map((item) => item.id)).toEqual(RUBRIC_IDS);
    }
  });

  it("rounds 69.5 up to 70, which is a pass", () => {
    // 29.5 + 25 + 15 + 0 = 69.5; Math.round sends an exact .5 up.
    const result = scoreEvaluation(
      challenge,
      grades({ pda_derivation: 29.5, account_relationships: 25, security_implications: 15 }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.score).toBe(70);
      expect(result.data.passed).toBe(true);
    }
  });

  it("rounds 69.4 down to 69, which is a fail", () => {
    const result = scoreEvaluation(
      challenge,
      grades({ pda_derivation: 29.4, account_relationships: 25, security_implications: 15 }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.score).toBe(69);
      expect(result.data.passed).toBe(false);
    }
  });

  it("caps the score at 100 even if every weight were over-awarded", () => {
    const inflated = grades({}).criteria.map((criterion) => ({ ...criterion, points: 1000 }));
    const result = scoreEvaluation(challenge, { ...grades({}), criteria: inflated });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.score).toBe(100);
    }
  });
});

describe("scoreEvaluation rejects output that does not describe the rubric", () => {
  it("rejects a missing criterion and names it", () => {
    const criteria = grades({}).criteria.filter((criterion) => criterion.id !== "clarity");
    const error = expectFailure(scoreEvaluation(challenge, { ...grades({}), criteria }));
    expect(error.code).toBe("model_output_invalid");
    expect(error.reasons.join(" ")).toContain("missing rubric criteria: clarity");
  });

  it("rejects a duplicated criterion id", () => {
    const criteria = [...grades({}).criteria];
    criteria.push({ id: "clarity", points: 20, comment: "again" });
    const error = expectFailure(scoreEvaluation(challenge, { ...grades({}), criteria }));
    expect(error.reasons.join(" ")).toContain('criterion "clarity" was graded twice');
  });

  it("rejects an unknown criterion id instead of quietly dropping it", () => {
    // Appended to a complete set: the invented id alone is enough to reject.
    const appended = [...grades({}).criteria, { id: "vibes", points: 40, comment: "invent a criterion" }];
    const error = expectFailure(scoreEvaluation(challenge, { ...grades({}), criteria: appended }));
    expect(error.code).toBe("model_output_invalid");
    expect(error.reasons.join(" ")).toContain('criterion "vibes" is not part of this rubric');

    // Swapping a real criterion for an invented one must not be a way to reach a
    // total: the real id is now missing, so the answer is still rejected.
    const swapped = grades({}).criteria.map((criterion) =>
      criterion.id === "clarity" ? { id: "vibes", points: 40, comment: "swap in an invention" } : criterion,
    );
    const swapError = expectFailure(scoreEvaluation(challenge, { ...grades({}), criteria: swapped }));
    expect(swapError.reasons.join(" ")).toContain("missing rubric criteria: clarity");
  });

  it("rejects blank feedback rather than shipping an empty verdict", () => {
    const error = expectFailure(scoreEvaluation(challenge, grades({}, { feedback: "   " })));
    expect(error.reasons).toContain("feedback was blank");
  });

  it("refuses to grade a rubric whose weights do not sum to 100", () => {
    const broken: Challenge = {
      ...challenge,
      rubric: [
        { id: "a", label: "A", weight: 60 },
        { id: "b", label: "B", weight: 30 },
      ],
    };
    const error = expectFailure(scoreEvaluation(broken, { criteria: [], strengths: [], weaknesses: [], feedback: "x" }));
    expect(error.code).toBe("rubric_invalid");
    expect(error.reasons.join(" ")).toContain("weights sum to 90");
  });

  it("refuses a rubric with duplicate ids", () => {
    const broken: Challenge = {
      ...challenge,
      rubric: [
        { id: "a", label: "A", weight: 50 },
        { id: "a", label: "A again", weight: 50 },
      ],
    };
    const error = expectFailure(scoreEvaluation(broken, grades({})));
    expect(error.code).toBe("rubric_invalid");
    expect(error.reasons.join(" ")).toContain('duplicate rubric id "a"');
  });

  it("never reports an ok result for any of the failures above", () => {
    const failure = scoreEvaluation(challenge, { ...grades({}), criteria: [] });
    expect(failure.ok).toBe(false);
  });
});

describe("scoreEvaluation normalises prose", () => {
  it("drops blank and duplicate list entries", () => {
    const result = scoreEvaluation(
      challenge,
      grades({}, { strengths: ["  ", "good", "good", ""], weaknesses: ["", "  ", "bad"] }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.strengths).toEqual(["good"]);
      expect(result.data.weaknesses).toEqual(["bad"]);
    }
  });

  it("trims feedback and fills a missing per-criterion comment", () => {
    const blanked = { ...grades({}), criteria: grades({}).criteria.map((c) => ({ ...c, comment: "  " })) };
    const result = scoreEvaluation(challenge, blanked);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.evaluatedCriteria[0].comment).toBe("No criterion-specific comment was provided.");
    }
  });
});

describe("the catalogue itself stays gradeable", () => {
  it("grades all five challenges without a rubric error", () => {
    for (const item of CHALLENGES) {
      const raw: ModelEvaluation = {
        criteria: item.rubric.map((criterion) => ({
          id: criterion.id,
          points: criterion.weight,
          comment: criterion.label,
        })),
        strengths: [],
        weaknesses: [],
        feedback: "fine",
      };
      const result = scoreEvaluation(item, raw);
      expect(result.ok, `challenge ${item.id}`).toBe(true);
      if (result.ok) {
        expect(result.data.score).toBe(100);
      }
    }
  });
});
