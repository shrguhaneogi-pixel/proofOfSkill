import { describe, expect, it } from "vitest";

import { CHALLENGES } from "./data";
import {
  ChallengeRowsError,
  mapRowsToCatalogue,
  type ChallengeRow,
  type RubricCriterionRow,
} from "./rows";
import type { Challenge } from "./types";

const STAMP = new Date("2026-01-01T00:00:00.000Z");

/**
 * Rows are built from the typed catalogue, so every mapping assertion below is
 * also a statement that the schema can hold what `data.ts` holds.
 */
function rowOf(challenge: Challenge): ChallengeRow {
  return {
    id: challenge.id,
    slug: challenge.slug,
    title: challenge.title,
    description: challenge.description,
    difficulty: challenge.difficulty,
    category: challenge.category,
    estimatedMinutes: challenge.estimatedMinutes,
    prompt: challenge.prompt,
    credentialType: challenge.credentialType,
    createdAt: STAMP,
    updatedAt: STAMP,
  };
}

/** A valid row, with the one field under test replaced. */
function challengeRow(overrides: Partial<ChallengeRow> = {}): ChallengeRow {
  return { ...rowOf(CHALLENGES[0]), ...overrides };
}

function criterionRow(
  challengeId: number,
  id: string,
  weight: number,
  ordinal: number,
  overrides: Partial<RubricCriterionRow> = {},
): RubricCriterionRow {
  return { challengeId, id, label: `Criterion ${id}`, weight, ordinal, ...overrides };
}

function rowsFrom(catalogue: readonly Challenge[]): {
  challengeRows: ChallengeRow[];
  criterionRows: RubricCriterionRow[];
} {
  return {
    challengeRows: catalogue.map(rowOf),
    criterionRows: catalogue.flatMap((challenge) =>
      challenge.rubric.map((criterion, ordinal) =>
        criterionRow(challenge.id, criterion.id, criterion.weight, ordinal, {
          label: criterion.label,
        }),
      ),
    ),
  };
}

function fourCriterionRubric(challengeId = 1): RubricCriterionRow[] {
  return [
    criterionRow(challengeId, "alpha", 40, 0),
    criterionRow(challengeId, "beta", 30, 1),
    criterionRow(challengeId, "gamma", 20, 2),
    criterionRow(challengeId, "delta", 10, 3),
  ];
}

describe("mapRowsToCatalogue", () => {
  it("reproduces the typed catalogue from rows", () => {
    const rows = rowsFrom(CHALLENGES);
    const mapped = mapRowsToCatalogue(rows.challengeRows, rows.criterionRows);

    expect(mapped.challenges).toEqual(CHALLENGES);
    expect(mapped.excluded).toEqual([]);
  });

  it("restores rubric order from the ordinal column, not from row order", () => {
    const rows = rowsFrom(CHALLENGES);
    const shuffled = [...rows.criterionRows].reverse();
    const mapped = mapRowsToCatalogue([...rows.challengeRows].reverse(), shuffled);

    expect(mapped.challenges[0]?.rubric.map((criterion) => criterion.id)).toEqual(
      CHALLENGES[0]?.rubric.map((criterion) => criterion.id),
    );
    expect(mapped.challenges.map((challenge) => challenge.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps every rubric summing to 100", () => {
    const rows = rowsFrom(CHALLENGES);
    const mapped = mapRowsToCatalogue(rows.challengeRows, rows.criterionRows);

    for (const challenge of mapped.challenges) {
      const total = challenge.rubric.reduce((sum, criterion) => sum + criterion.weight, 0);
      expect(total, `challenge ${challenge.id}`).toBe(100);
    }
  });

  it("rejects a rubric whose weights do not total 100", () => {
    const short = fourCriterionRubric().slice(0, 3);

    expect(() => mapRowsToCatalogue([challengeRow()], short)).toThrow(ChallengeRowsError);
    expect(() => mapRowsToCatalogue([challengeRow()], short)).toThrowError(
      /challenge 1 weights sum to 90, expected 100/,
    );
  });

  it("rejects a challenge with no criteria at all", () => {
    expect(() => mapRowsToCatalogue([challengeRow()], [])).toThrowError(/has no rubric criteria/);
  });

  it("rejects a weight that is not a positive integer", () => {
    const criteria = fourCriterionRubric();
    criteria[0] = criterionRow(1, "alpha", 0, 0);

    expect(() => mapRowsToCatalogue([challengeRow()], criteria)).toThrowError(/weight 0/);

    const fractional = fourCriterionRubric();
    fractional[1] = criterionRow(1, "beta", 30.5, 1);
    expect(() => mapRowsToCatalogue([challengeRow()], fractional)).toThrowError(/weight 30\.5/);
  });

  it("rejects a weight that exceeds the whole rubric", () => {
    const criteria = fourCriterionRubric();
    criteria[0] = criterionRow(1, "alpha", 101, 0);

    expect(() => mapRowsToCatalogue([challengeRow()], criteria)).toThrowError(/expected an integer from 1 to 100/);
  });

  it("rejects two criteria at the same position", () => {
    const criteria = fourCriterionRubric();
    criteria[3] = criterionRow(1, "delta", 10, 2);

    expect(() => mapRowsToCatalogue([challengeRow()], criteria)).toThrowError(
      /two criteria at position 2/,
    );
  });

  it("rejects a duplicate criterion id", () => {
    const criteria = fourCriterionRubric();
    criteria[3] = criterionRow(1, "alpha", 10, 3);

    expect(() => mapRowsToCatalogue([challengeRow()], criteria)).toThrowError(
      /duplicate criterion id "alpha"/,
    );
  });

  it("rejects an unknown difficulty or category", () => {
    expect(() =>
      mapRowsToCatalogue([challengeRow({ difficulty: "expert" })], fourCriterionRubric()),
    ).toThrowError(/unknown difficulty "expert"/);
    expect(() =>
      mapRowsToCatalogue([challengeRow({ category: "Blockchain" })], fourCriterionRubric()),
    ).toThrowError(/unknown category "Blockchain"/);
  });

  it("rejects a blank user-facing string and a non-positive estimate", () => {
    expect(() =>
      mapRowsToCatalogue([challengeRow({ prompt: "   " })], fourCriterionRubric()),
    ).toThrowError(/blank prompt/);
    expect(() =>
      mapRowsToCatalogue([challengeRow({ estimatedMinutes: 0 })], fourCriterionRubric()),
    ).toThrowError(/estimatedMinutes 0/);
  });

  it("reports every problem at once instead of only the first", () => {
    const error = captureRowsError(() =>
      mapRowsToCatalogue(
        [challengeRow({ difficulty: "expert", category: "Blockchain" })],
        fourCriterionRubric(),
      ),
    );

    expect(error.reasons).toHaveLength(2);
    expect(error.message).toContain("unknown difficulty");
    expect(error.message).toContain("unknown category");
  });

  it("excludes a row the onchain program cannot address, and keeps the rest", () => {
    const mapped = mapRowsToCatalogue(
      [challengeRow({ id: 6 }), challengeRow({ id: 2, slug: "b" })],
      [
        ...fourCriterionRubric(6),
        ...fourCriterionRubric(2).map((row) => ({ ...row, challengeId: 2 })),
      ],
    );

    expect(mapped.excluded).toEqual([
      {
        code: "id_out_of_program_range",
        challengeId: 6,
        reason: expect.stringContaining("outside the ids the program accepts"),
      },
    ]);
    expect(mapped.challenges.map((challenge) => challenge.id)).toEqual([2]);
  });

  it("excludes a second row claiming an id already built", () => {
    const mapped = mapRowsToCatalogue(
      [challengeRow(), challengeRow({ slug: "other-slug" })],
      fourCriterionRubric(),
    );

    expect(mapped.challenges).toHaveLength(1);
    expect(mapped.excluded).toEqual([
      { code: "duplicate_id", challengeId: 1, reason: expect.stringContaining("already uses id 1") },
    ]);
  });

  it("treats criteria whose challenge is missing entirely as fatal", () => {
    expect(() =>
      mapRowsToCatalogue([challengeRow()], [
        ...fourCriterionRubric(1),
        criterionRow(4, "orphan", 100, 0),
      ]),
    ).toThrowError(/reference challenge 4, which no returned row has/);
  });
});

function captureRowsError(run: () => unknown): ChallengeRowsError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ChallengeRowsError);
    return error as ChallengeRowsError;
  }
  throw new Error("expected a ChallengeRowsError");
}
