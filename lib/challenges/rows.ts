/**
 * Database row set → the typed `Challenge` the whole app already consumes.
 *
 * Pure: no I/O, no clock, no query builder — only the row *shapes*, so a test can
 * hand it an array that stands in for Postgres. The import of `db/schema.ts` is
 * for the `$inferSelect` row types and the rubric total, which keeps the number a
 * rubric has to sum to in one place.
 *
 * Two failure classes, deliberately handled differently:
 *
 * - A row whose `id` the program cannot address (outside `MIN_CHALLENGE_ID..=MAX_CHALLENGE_ID`)
 *   is *excluded* and reported, not fatal. Its credential could never be issued
 *   onchain, so leaving it in the catalogue would advertise a challenge that is
 *   guaranteed to fail; but accepting it silently would widen the id set the chain
 *   pins, which is the drift `lib/program-contract.ts` exists to prevent. Excluding
 *   with a visible reason costs one challenge and leaves the rest working.
 * - A row that is structurally unusable — a rubric that does not total 100, an
 *   unknown difficulty, a blank prompt — is fatal (`ChallengeRowsError`). Grading
 *   against a mis-summed rubric is how a server comes to believe it issued a valid
 *   pass that the chain disagrees with, and a page cannot tell a candidate that the
 *   rubric underneath them is short 10 points. Better to fail the read.
 */

import {
  RUBRIC_TOTAL_POINTS,
  type challenges as challengesTable,
  type rubricCriteria as rubricCriteriaTable,
} from "../../db/schema.ts";

import { CHALLENGE_IDS } from "./types";
import type { Category, Challenge, ChallengeId, Difficulty, RubricCriterion } from "./types";

/** The row shape `select().from(challenges)` produces. */
export type ChallengeRow = (typeof challengesTable)["$inferSelect"];
/** The row shape `select().from(rubricCriteria)` produces. */
export type RubricCriterionRow = (typeof rubricCriteriaTable)["$inferSelect"];

/** A challenge row whose id is one the onchain program will accept. */
type AcceptedChallengeRow = ChallengeRow & { id: ChallengeId };

/** A row the loader refused to put in the catalogue, with the reason a caller can surface. */
export type CatalogueExclusion = {
  code: "id_out_of_program_range" | "duplicate_id";
  challengeId: number;
  reason: string;
};

export type MappedCatalogue = {
  challenges: Challenge[];
  excluded: CatalogueExclusion[];
};

/**
 * Thrown when the rows cannot be used at all. `reasons` names the offending
 * challenge and column — never a value, and never candidate or model prose.
 */
export class ChallengeRowsError extends Error {
  readonly reasons: readonly string[];

  constructor(reasons: readonly string[]) {
    super(`Challenge rows are not usable: ${reasons.join("; ")}.`);
    this.name = "ChallengeRowsError";
    this.reasons = reasons;
  }
}

const ACCEPTED_CHALLENGE_IDS: ReadonlySet<number> = new Set<number>(CHALLENGE_IDS);

const DIFFICULTIES: readonly Difficulty[] = ["beginner", "intermediate", "advanced"];
const CATEGORIES: readonly Category[] = ["Solana", "Anchor", "Web3 Frontend", "Security"];

function rowHasAcceptedId(row: ChallengeRow): row is AcceptedChallengeRow {
  return ACCEPTED_CHALLENGE_IDS.has(row.id);
}

function isDifficulty(value: string): value is Difficulty {
  return (DIFFICULTIES as readonly string[]).includes(value);
}

function isCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value);
}

function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isWeight(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= RUBRIC_TOTAL_POINTS;
}

function isOrdinal(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * One rubric is gradeable when it is non-empty, its criterion ids and positions
 * are unique, every weight is an integer between 1 and the rubric total, and the
 * weights sum to exactly `RUBRIC_TOTAL_POINTS`. This mirrors `validateRubric` in
 * `lib/evaluation/scoring.ts`, which stays the last line of defence at grading
 * time; checking it here keeps a broken catalogue from ever reaching a page.
 */
function rubricFromRows(
  challengeId: number,
  rows: readonly RubricCriterionRow[],
  reasons: string[],
): RubricCriterion[] | null {
  if (rows.length === 0) {
    reasons.push(`challenge ${String(challengeId)} has no rubric criteria`);
    return null;
  }

  const failures: string[] = [];
  const seenIds = new Set<string>();
  const seenOrdinals = new Set<number>();
  let total = 0;

  // Sorted by position before anything else: the array order is what the evaluator
  // prompt, the challenge page and `data.test.ts` all promise a candidate, and a
  // relational read does not guarantee it.
  const ordered = [...rows].sort((left, right) =>
    left.ordinal === right.ordinal
      ? left.id.localeCompare(right.id)
      : left.ordinal - right.ordinal,
  );

  for (const row of ordered) {
    const label = `criterion "${row.id}" of challenge ${String(challengeId)}`;

    if (!isNonBlank(row.id)) {
      failures.push(`challenge ${String(challengeId)} has a criterion with a blank id`);
      continue;
    }
    if (seenIds.has(row.id)) {
      failures.push(`challenge ${String(challengeId)} has duplicate criterion id "${row.id}"`);
      continue;
    }
    seenIds.add(row.id);

    if (!isNonBlank(row.label)) {
      failures.push(`${label} has a blank label`);
    }
    if (!isWeight(row.weight)) {
      failures.push(
        `${label} has weight ${String(row.weight)}, expected an integer from 1 to ${String(RUBRIC_TOTAL_POINTS)}`,
      );
      continue;
    }
    if (!isOrdinal(row.ordinal)) {
      failures.push(`${label} has ordinal ${String(row.ordinal)}, expected a non-negative integer`);
      continue;
    }
    if (seenOrdinals.has(row.ordinal)) {
      failures.push(`challenge ${String(challengeId)} has two criteria at position ${String(row.ordinal)}`);
      continue;
    }
    seenOrdinals.add(row.ordinal);

    total += row.weight;
  }

  if (failures.length === 0 && total !== RUBRIC_TOTAL_POINTS) {
    failures.push(
      `challenge ${String(challengeId)} weights sum to ${String(total)}, expected ${String(RUBRIC_TOTAL_POINTS)}`,
    );
  }

  if (failures.length > 0) {
    reasons.push(...failures);
    return null;
  }

  return ordered.map((row) => ({ id: row.id, label: row.label, weight: row.weight }));
}

function buildChallenge(
  row: AcceptedChallengeRow,
  difficulty: Difficulty,
  category: Category,
  rubric: RubricCriterion[],
): Challenge {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    difficulty,
    category,
    estimatedMinutes: row.estimatedMinutes,
    prompt: row.prompt,
    rubric,
    credentialType: row.credentialType,
  };
}

/**
 * Maps a flat row set into the catalogue. `criterionRows` may arrive in any order;
 * rubric order is restored from `ordinal`, and the challenges come back by id.
 *
 * @throws {ChallengeRowsError} when a row is structurally unusable.
 */
export function mapRowsToCatalogue(
  challengeRows: readonly ChallengeRow[],
  criterionRows: readonly RubricCriterionRow[],
): MappedCatalogue {
  const reasons: string[] = [];
  const excluded: CatalogueExclusion[] = [];

  const criteriaByChallenge = new Map<number, RubricCriterionRow[]>();
  for (const row of criterionRows) {
    const bucket = criteriaByChallenge.get(row.challengeId);
    if (bucket === undefined) {
      criteriaByChallenge.set(row.challengeId, [row]);
    } else {
      bucket.push(row);
    }
  }

  const catalogue: Challenge[] = [];
  const seenRows = new Set<number>();
  const builtIds = new Set<number>();

  for (const row of [...challengeRows].sort((left, right) => left.id - right.id)) {
    if (!rowHasAcceptedId(row)) {
      // Excluded, not fatal. Its criteria are covered by this exclusion, so they
      // must not be counted as orphans below.
      seenRows.add(row.id);
      excluded.push({
        code: "id_out_of_program_range",
        challengeId: row.id,
        reason: `id ${String(row.id)} is outside the ids the program accepts (${CHALLENGE_IDS.join(", ")})`,
      });
      continue;
    }
    if (builtIds.has(row.id)) {
      seenRows.add(row.id);
      excluded.push({
        code: "duplicate_id",
        challengeId: row.id,
        reason: `another row already uses id ${String(row.id)}`,
      });
      continue;
    }
    seenRows.add(row.id);

    const rowFailures: string[] = [];
    const difficulty = isDifficulty(row.difficulty) ? row.difficulty : null;
    const category = isCategory(row.category) ? row.category : null;
    if (difficulty === null) {
      rowFailures.push(`challenge ${String(row.id)} has unknown difficulty "${row.difficulty}"`);
    }
    if (category === null) {
      rowFailures.push(`challenge ${String(row.id)} has unknown category "${row.category}"`);
    }
    if (!Number.isInteger(row.estimatedMinutes) || row.estimatedMinutes <= 0) {
      rowFailures.push(
        `challenge ${String(row.id)} has estimatedMinutes ${String(row.estimatedMinutes)}, expected a positive integer`,
      );
    }
    for (const field of ["slug", "title", "description", "prompt", "credentialType"] as const) {
      if (!isNonBlank(row[field])) {
        rowFailures.push(`challenge ${String(row.id)} has a blank ${field}`);
      }
    }
    // The two `=== null` terms are unreachable when `rowFailures` is empty — each
    // one pushes a failure — but spelling them out is what lets the narrowed types
    // reach `buildChallenge` without a cast.
    if (difficulty === null || category === null || rowFailures.length > 0) {
      reasons.push(...rowFailures);
      continue;
    }

    const rubric = rubricFromRows(row.id, criteriaByChallenge.get(row.id) ?? [], reasons);
    if (rubric === null) {
      // `rubricFromRows` already pushed the reasons.
      continue;
    }

    builtIds.add(row.id);
    catalogue.push(buildChallenge(row, difficulty, category, rubric));
  }

  for (const challengeId of criteriaByChallenge.keys()) {
    if (!seenRows.has(challengeId)) {
      reasons.push(
        `rubric criteria reference challenge ${String(challengeId)}, which no returned row has`,
      );
    }
  }

  if (reasons.length > 0) {
    throw new ChallengeRowsError(reasons);
  }

  return { challenges: catalogue, excluded };
}
