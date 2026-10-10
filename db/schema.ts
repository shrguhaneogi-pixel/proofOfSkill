/**
 * Postgres schema for the challenge catalogue (Phase 3).
 *
 * The catalogue used to live only in `lib/challenges/data.ts`. That file is still
 * the fallback the app runs on when `DATABASE_URL` is unset, so nothing here is
 * required for the app to boot; the schema is the source of truth only once it is
 * configured and seeded (`node scripts/seed-challenges.ts`).
 *
 * Invariants this schema has to keep, and how each one is kept:
 *
 * 1. `id` is the onchain challenge id, not a surrogate key. The program only
 *    accepts `MIN_CHALLENGE_ID..=MAX_CHALLENGE_ID`
 *    (`programs/proof_of_skill/src/constants.rs`, mirrored in
 *    `lib/program-contract.ts`), so a row with id 6 would produce a credential the
 *    chain rejects while the server believes it issued a valid pass. `smallint`
 *    rather than serial/UUID for exactly that reason, with a CHECK binding the
 *    column to the accepted range. Raising the ceiling means a new migration *and*
 *    a program redeploy, in that order — the CHECK is deliberately loud about it.
 * 2. A rubric's weights must sum to `RUBRIC_TOTAL_POINTS`. A Postgres CHECK
 *    constraint is row-local and cannot sum across the child rows, so there is no
 *    honest DB-level expression for it short of a trigger, which drizzle-kit
 *    cannot generate. The chosen mechanism is therefore a *documented* invariant
 *    plus enforcement at both ends of the boundary: the seed refuses to write a
 *    rubric that does not total 100 (`lib/challenges/seed.ts`) and the reader
 *    refuses to hand one back (`lib/challenges/rows.ts`), with
 *    `lib/evaluation/scoring.ts` as the last line for a rubric that got through.
 *    What *is* expressible per row is checked here: weight > 0 and weight <= the
 *    total, so a single criterion can never hold more than the whole rubric.
 * 3. `Challenge.rubric` is an ordered array in the typed catalogue, and both the
 *    evaluator prompt and the challenge page render it in that order. A relational
 *    read has no natural order, so `ordinal` exists and the reader sorts by it.
 *
 * There is deliberately no `pass_threshold` column. The threshold is
 * `PASS_THRESHOLD` in the program (70 of 100) and a per-row copy in a mutable
 * table would be a second source of truth for a value the chain enforces; the
 * same reasoning applies to the score ceiling.
 */

// Relative imports below spell out `.ts` because this module is also loaded by
// `node scripts/seed-challenges.ts`, which runs the type-stripped source without a
// bundler and so cannot resolve extensionless specifiers. See the matching
// `allowImportingTsExtensions` in tsconfig.json.
import { sql, type SQL } from "drizzle-orm";
import {
  check,
  integer,
  pgTable,
  type PgColumn,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { MAX_CHALLENGE_ID, MIN_CHALLENGE_ID } from "../lib/program-contract.ts";

/** Every point a graded rubric can hand out. Equals `MAX_SCORE` onchain. */
export const RUBRIC_TOTAL_POINTS = 100;

/**
 * Kept in sync with `Difficulty` in `lib/challenges/types.ts`, which is the
 * TypeScript source of truth; this list is the database-side guard against a
 * hand-edited row, and changing the union means changing both.
 */
const DIFFICULTY_VALUES_SQL = "'beginner', 'intermediate', 'advanced'";

/** Same caveat as `DIFFICULTY_VALUES_SQL`, for `Category`. */
const CATEGORY_VALUES_SQL = "'Solana', 'Anchor', 'Web3 Frontend', 'Security'";

/** A user-facing string that renders as nothing is a bug, so it is not storable. */
function nonBlank(column: PgColumn): SQL {
  return sql`char_length(btrim(${column})) > 0`;
}

/**
 * Numbers inside a CHECK constraint have to be literal in the generated DDL:
 * drizzle turns a plain interpolated value into a bind parameter (`$1`), and
 * `CREATE TABLE ... CHECK ("id" >= $1)` is not valid Postgres — the migration
 * would fail to apply. `sql.raw` is the only safe way to put a value in DDL, and
 * every argument here is a number this file owns, never user input.
 */
function literal(value: number): SQL {
  return sql.raw(String(value));
}

export const challenges = pgTable(
  "challenges",
  {
    /** The onchain challenge id. See invariant 1 in the file header. */
    id: smallint("id").primaryKey(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    /** The one-line summary the catalogue cards show. */
    description: text("description").notNull(),
    difficulty: text("difficulty").notNull(),
    category: text("category").notNull(),
    estimatedMinutes: integer("estimated_minutes").notNull(),
    /** The full candidate-facing brief. Multi-paragraph, so never a `varchar(n)`. */
    prompt: text("prompt").notNull(),
    credentialType: text("credential_type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("challenges_slug_unique").on(t.slug),
    check(
      "challenges_id_in_program_range",
      sql`${t.id} >= ${literal(MIN_CHALLENGE_ID)} AND ${t.id} <= ${literal(MAX_CHALLENGE_ID)}`,
    ),
    check("challenges_difficulty_allowed", sql`${t.difficulty} IN (${sql.raw(DIFFICULTY_VALUES_SQL)})`),
    check("challenges_category_allowed", sql`${t.category} IN (${sql.raw(CATEGORY_VALUES_SQL)})`),
    check("challenges_estimated_minutes_positive", sql`${t.estimatedMinutes} > 0`),
    check("challenges_slug_not_blank", nonBlank(t.slug)),
    check("challenges_slug_is_kebab_case", sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check("challenges_title_not_blank", nonBlank(t.title)),
    check("challenges_description_not_blank", nonBlank(t.description)),
    check("challenges_prompt_not_blank", nonBlank(t.prompt)),
    check("challenges_credential_type_not_blank", nonBlank(t.credentialType)),
  ],
);

export const rubricCriteria = pgTable(
  "rubric_criteria",
  {
    challengeId: smallint("challenge_id")
      .notNull()
      .references(() => challenges.id, { onDelete: "cascade" }),
    /** The stable criterion key the evaluator grades against (`pda_derivation`). */
    id: text("id").notNull(),
    label: text("label").notNull(),
    /**
     * The criterion's share of `RUBRIC_TOTAL_POINTS`, and also the most points it
     * can award — `Challenge.rubric[].weight` and `EvaluatedCriterion.weight` are
     * the same number, so there is no separate max column.
     */
    weight: integer("weight").notNull(),
    /** Position within the rubric. Restores the array order the typed catalogue had. */
    ordinal: smallint("ordinal").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.challengeId, t.id] }),
    uniqueIndex("rubric_criteria_position_unique").on(t.challengeId, t.ordinal),
    check("rubric_criteria_weight_positive", sql`${t.weight} > 0`),
    check("rubric_criteria_weight_within_total", sql`${t.weight} <= ${literal(RUBRIC_TOTAL_POINTS)}`),
    check("rubric_criteria_ordinal_non_negative", sql`${t.ordinal} >= 0`),
    check("rubric_criteria_id_not_blank", nonBlank(t.id)),
    check("rubric_criteria_id_is_snake_case", sql`${t.id} ~ '^[a-z][a-z0-9_]{0,62}$'`),
    check("rubric_criteria_label_not_blank", nonBlank(t.label)),
  ],
);

export const schema = { challenges, rubricCriteria };
