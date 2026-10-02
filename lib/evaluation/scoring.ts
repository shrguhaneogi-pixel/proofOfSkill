/**
 * The trusted half of the evaluator. The model proposes points; this file
 * decides everything that is actually asserted to the user, including
 * pass/fail (`docs/api-schema.md` → EVALUATOR_CONTRACT, `docs/living-notes.md`
 * → "Server recomputes score from rubric weights; model output is never trusted
 * for `passed`").
 *
 * No I/O, no clock, no randomness: same input in, same result out.
 */

import type { Challenge, RubricCriterion } from "../challenges/types";
import type { ModelEvaluation } from "./schema";
import { PASS_THRESHOLD, type CriterionStatus, type EvaluatedCriterion } from "./types";

const TOTAL_RUBRIC_WEIGHT = 100;
const MET_RATIO = 0.8;
const PARTIAL_RATIO = 0.4;

/** Bound the size of anything we echo back into client state. */
const MAX_LIST_ITEMS = 12;
const MAX_ITEM_CHARS = 600;
const MAX_FEEDBACK_CHARS = 8000;

export type ScoringErrorCode =
  /** The challenge catalogue itself is broken — a repo bug, not a model bug. */
  | "rubric_invalid"
  /** The model's output did not describe this rubric. */
  | "model_output_invalid";

export type ScoringFailure = {
  code: ScoringErrorCode;
  /** User-safe summary. */
  message: string;
  /** Developer-safe specifics (criterion ids only, never model prose). */
  reasons: string[];
};

export type ScoredEvaluation = {
  score: number;
  passed: boolean;
  passThreshold: typeof PASS_THRESHOLD;
  strengths: string[];
  weaknesses: string[];
  feedback: string;
  evaluatedCriteria: EvaluatedCriterion[];
};

export type ScoringResult = { ok: true; data: ScoredEvaluation } | { ok: false; error: ScoringFailure };

function invalidRubric(reasons: string[]): ScoringFailure {
  return {
    code: "rubric_invalid",
    message: "This challenge's rubric is not a valid 100-point grading scheme.",
    reasons,
  };
}

function invalidOutput(reasons: string[]): ScoringFailure {
  return {
    code: "model_output_invalid",
    message: "The evaluator returned grades that do not match this challenge's rubric.",
    reasons,
  };
}

/**
 * A rubric is gradeable when every criterion has a unique id, a label and a
 * finite positive weight, and the weights sum to exactly 100. `data.test.ts`
 * asserts this for the catalogue; re-checking here means a bad catalogue entry
 * can never silently produce a bad score.
 */
function validateRubric(rubric: RubricCriterion[]): ScoringFailure | null {
  if (rubric.length === 0) {
    return invalidRubric(["rubric is empty"]);
  }

  const reasons: string[] = [];
  const seen = new Set<string>();
  let total = 0;

  for (const criterion of rubric) {
    if (criterion.id.trim() === "") {
      reasons.push("criterion with an empty id");
    }
    if (seen.has(criterion.id)) {
      reasons.push(`duplicate rubric id "${criterion.id}"`);
    }
    seen.add(criterion.id);

    if (!Number.isFinite(criterion.weight) || criterion.weight <= 0) {
      reasons.push(`criterion "${criterion.id}" weight must be a positive finite number`);
      continue;
    }
    if (criterion.label.trim() === "") {
      reasons.push(`criterion "${criterion.id}" has an empty label`);
    }
    total += criterion.weight;
  }

  if (total !== TOTAL_RUBRIC_WEIGHT) {
    reasons.push(`weights sum to ${total}, expected ${TOTAL_RUBRIC_WEIGHT}`);
  }

  return reasons.length > 0 ? invalidRubric(reasons) : null;
}

/**
 * Clamps into `[0, weight]`. Anything that is not a finite number becomes 0 —
 * the schema already rejects those, this is defence for callers that hand us
 * parsed JSON directly.
 */
export function clampPoints(points: number, weight: number): number {
  if (!Number.isFinite(points) || points <= 0) {
    return 0;
  }
  if (points >= weight) {
    return weight;
  }
  return points;
}

/**
 * `>=80%` of the weight is met, `>=40%` is partial, below that is not_met.
 *
 * Compared as a quotient, not as `weight * 0.8`: `20 / 25` and `24 / 30` round to
 * exactly the double written for the literals below, whereas `25 * 0.8` can drift
 * off the boundary and make an exact-80% grade read as partial.
 */
export function criterionStatus(pointsAwarded: number, weight: number): CriterionStatus {
  if (!(weight > 0) || !Number.isFinite(pointsAwarded)) {
    return "not_met";
  }
  const ratio = pointsAwarded / weight;
  if (ratio >= MET_RATIO) {
    return "met";
  }
  if (ratio >= PARTIAL_RATIO) {
    return "partial";
  }
  return "not_met";
}

function normalizeList(values: string[]): string[] {
  const cleaned: string[] = [];
  for (const value of values) {
    const text = value.trim();
    if (text === "") {
      continue;
    }
    if (!cleaned.includes(text)) {
      cleaned.push(truncate(text, MAX_ITEM_CHARS));
    }
    if (cleaned.length >= MAX_LIST_ITEMS) {
      break;
    }
  }
  return cleaned;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}\u2026`;
}

const NO_COMMENT_TEXT = "No criterion-specific comment was provided.";

function commentFor(raw: ModelEvaluation, id: string): string {
  const comment = raw.criteria.find((criterion) => criterion.id === id)?.comment.trim() ?? "";
  return truncate(comment === "" ? NO_COMMENT_TEXT : comment, MAX_ITEM_CHARS);
}

/**
 * Grades raw model output against a challenge rubric.
 *
 * Every rubric id must appear exactly once in `raw.criteria`; unknown ids are
 * rejected rather than dropped, because dropping them would let a model inflate
 * the score with invented criteria. `score` is `round(sum(clamped points))`, so
 * it is a whole number 0–100; `Math.round` sends an exact `.5` up, which is what
 * makes a 69.5 total a pass.
 */
export function scoreEvaluation(challenge: Challenge, raw: ModelEvaluation): ScoringResult {
  const rubricFailure = validateRubric(challenge.rubric);
  if (rubricFailure) {
    return { ok: false, error: rubricFailure };
  }

  const reasons: string[] = [];
  const awarded = new Map<string, number>();

  for (const criterion of raw.criteria) {
    if (awarded.has(criterion.id)) {
      reasons.push(`criterion "${criterion.id}" was graded twice`);
      continue;
    }
    if (!challenge.rubric.some((item) => item.id === criterion.id)) {
      reasons.push(`criterion "${criterion.id}" is not part of this rubric`);
      continue;
    }
    awarded.set(criterion.id, criterion.points);
  }

  const missing = challenge.rubric.filter((item) => !awarded.has(item.id));
  if (missing.length > 0) {
    reasons.push(`missing rubric criteria: ${missing.map((item) => item.id).join(", ")}`);
  }

  if (reasons.length > 0) {
    return { ok: false, error: invalidOutput(reasons) };
  }

  const evaluatedCriteria: EvaluatedCriterion[] = challenge.rubric.map((criterion) => {
    const pointsAwarded = clampPoints(awarded.get(criterion.id) ?? 0, criterion.weight);
    return {
      id: criterion.id,
      label: criterion.label,
      weight: criterion.weight,
      pointsAwarded,
      status: criterionStatus(pointsAwarded, criterion.weight),
      comment: commentFor(raw, criterion.id),
    };
  });

  const sum = evaluatedCriteria.reduce((total, item) => total + item.pointsAwarded, 0);
  const score = Math.min(TOTAL_RUBRIC_WEIGHT, Math.max(0, Math.round(sum)));

  const feedback = truncate(raw.feedback.trim(), MAX_FEEDBACK_CHARS);
  if (feedback === "") {
    return { ok: false, error: invalidOutput(["feedback was blank"]) };
  }

  return {
    ok: true,
    data: {
      score,
      passed: score >= PASS_THRESHOLD,
      passThreshold: PASS_THRESHOLD,
      strengths: normalizeList(raw.strengths),
      weaknesses: normalizeList(raw.weaknesses),
      feedback,
      evaluatedCriteria,
    },
  };
}
