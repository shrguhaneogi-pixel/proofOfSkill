/**
 * Idempotent upsert of a `Challenge[]` into the catalogue tables.
 *
 * Deliberately *not* `server-only`: `scripts/seed-challenges.ts` runs it under
 * plain `node`, where the `server-only` package throws on import. Everything that
 * touches a connection lives in `lib/challenges/source.ts`; this file only builds
 * statements, so the client is injected and a test can watch what it was asked to
 * do without a Postgres anywhere.
 *
 * Convergence rules:
 *
 * - Challenge rows are upserted on their primary key (`id`), so running the seed
 *   twice leaves the same five rows with the same content. Ids are the onchain
 *   challenge ids, which is why they are values here and not generated.
 * - Rubric rows for a challenge are replaced wholesale inside the same
 *   transaction: criteria are keyed by a human-readable id that a reworded rubric
 *   may rename, and an upsert alone would leave the renamed criterion's old row
 *   behind, summing the rubric past 100. Delete-then-insert makes the rubric match
 *   the catalogue exactly, ordinal by ordinal.
 * - Challenge rows are never deleted. An id the program has already issued
 *   credentials for stays readable forever (`ON DELETE CASCADE` would take its
 *   rubric with it and make past credentials unexplainable), so retiring a
 *   challenge is a content decision this script does not make.
 * - The whole catalogue is validated before the first statement: a rubric that
 *   does not total `RUBRIC_TOTAL_POINTS`, or an id outside the range the program
 *   accepts, must fail here rather than land in a table the loader then refuses.
 */

import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { RUBRIC_TOTAL_POINTS, challenges, rubricCriteria, schema } from "../../db/schema.ts";
import { CHALLENGE_IDS } from "./types.ts";
import type { Challenge } from "./types.ts";

/** The catalogue columns a seed writes; everything else is derived or generated. */
type ChallengeContent = {
  slug: string;
  title: string;
  description: string;
  difficulty: string;
  category: string;
  estimatedMinutes: number;
  prompt: string;
  credentialType: string;
};

/**
 * `transaction` is required, not optional: half a catalogue seeded by a statement
 * that failed midway is worse than one that never ran, because the loader would
 * then hand back a rubric that cannot total 100.
 */
export type SeedClient = Pick<NodePgDatabase<typeof schema>, "transaction">;

export type SeedSummary = {
  readonly challengeRows: number;
  readonly criterionRows: number;
};

/** Thrown before any statement runs. `reasons` names the field, never the value. */
export class ChallengeSeedError extends Error {
  readonly reasons: readonly string[];

  constructor(reasons: readonly string[]) {
    super(`Challenge catalogue cannot be seeded: ${reasons.join("; ")}.`);
    this.name = "ChallengeSeedError";
    this.reasons = reasons;
  }
}

const ACCEPTED_CHALLENGE_IDS: ReadonlySet<number> = new Set<number>(CHALLENGE_IDS);

/** Mirrors `challenges_slug_is_kebab_case` in `db/schema.ts`, so the failure names the field. */
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Mirrors `rubric_criteria_id_is_snake_case` in `db/schema.ts`. */
const CRITERION_ID_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

function nonBlank(value: string): boolean {
  return value.trim().length > 0;
}

/**
 * Everything the database would otherwise reject with a constraint name, plus the
 * rubric total the database cannot express as a CHECK across rows.
 *
 * @throws {ChallengeSeedError}
 */
export function validateCatalogue(catalogue: readonly Challenge[]): void {
  const reasons: string[] = [];

  if (catalogue.length === 0) {
    throw new ChallengeSeedError(["the catalogue is empty"]);
  }

  const ids = new Set<number>();
  const slugs = new Set<string>();

  for (const challenge of catalogue) {
    const where = `challenge ${String(challenge.id)}`;

    if (!Number.isInteger(challenge.id) || !ACCEPTED_CHALLENGE_IDS.has(challenge.id)) {
      reasons.push(
        `${where}: id is outside the range the onchain program accepts (${CHALLENGE_IDS.join(", ")}), so a credential for it could never be issued`,
      );
    }
    if (ids.has(challenge.id)) {
      reasons.push(`${where}: duplicate id`);
    }
    ids.add(challenge.id);

    if (!nonBlank(challenge.slug)) {
      reasons.push(`${where}: blank slug`);
    } else {
      if (!SLUG_PATTERN.test(challenge.slug)) {
        reasons.push(`${where}: slug "${challenge.slug}" is not kebab-case`);
      }
      if (slugs.has(challenge.slug)) {
        reasons.push(`${where}: duplicate slug "${challenge.slug}"`);
      }
      slugs.add(challenge.slug);
    }

    for (const field of ["title", "description", "prompt", "credentialType"] as const) {
      if (!nonBlank(challenge[field])) {
        reasons.push(`${where}: blank ${field}`);
      }
    }

    if (!Number.isInteger(challenge.estimatedMinutes) || challenge.estimatedMinutes <= 0) {
      reasons.push(`${where}: estimatedMinutes must be a positive integer`);
    }

    if (challenge.rubric.length === 0) {
      reasons.push(`${where}: rubric is empty`);
    }

    const criterionIds = new Set<string>();
    let total = 0;
    for (const criterion of challenge.rubric) {
      if (!nonBlank(criterion.id) || !CRITERION_ID_PATTERN.test(criterion.id)) {
        reasons.push(`${where}: criterion id "${criterion.id}" is not snake_case`);
      }
      if (criterionIds.has(criterion.id)) {
        reasons.push(`${where}: duplicate criterion id "${criterion.id}"`);
      }
      criterionIds.add(criterion.id);

      if (!nonBlank(criterion.label)) {
        reasons.push(`${where}: criterion "${criterion.id}" has a blank label`);
      }
      if (!Number.isInteger(criterion.weight) || criterion.weight <= 0) {
        reasons.push(`${where}: criterion "${criterion.id}" has a non-positive weight`);
        continue;
      }
      total += criterion.weight;
    }

    if (total !== RUBRIC_TOTAL_POINTS) {
      reasons.push(
        `${where}: rubric weights sum to ${String(total)}, expected ${String(RUBRIC_TOTAL_POINTS)}`,
      );
    }
  }

  if (reasons.length > 0) {
    throw new ChallengeSeedError(reasons);
  }
}

function challengeContent(challenge: Challenge): ChallengeContent {
  return {
    slug: challenge.slug,
    title: challenge.title,
    description: challenge.description,
    difficulty: challenge.difficulty,
    category: challenge.category,
    estimatedMinutes: challenge.estimatedMinutes,
    prompt: challenge.prompt,
    credentialType: challenge.credentialType,
  };
}

/**
 * Rubric order is the array order of the catalogue: `ordinal` is what
 * `lib/challenges/rows.ts` sorts back out, and it is derived here rather than
 * stored by hand so a reseed cannot drift from the source array.
 */
function criterionValues(challenge: Challenge) {
  return challenge.rubric.map((criterion, index) => ({
    challengeId: challenge.id,
    id: criterion.id,
    label: criterion.label,
    weight: criterion.weight,
    ordinal: index,
  }));
}

/**
 * Upserts `catalogue` inside one transaction and reports how many rows it wrote.
 * Safe to run repeatedly: the statements are keyed by primary key, and the second
 * run changes nothing but `updated_at`.
 *
 * @throws {ChallengeSeedError} when the catalogue is not seedable — before any
 * statement reaches the database.
 */
export async function seedChallenges(
  client: SeedClient,
  catalogue: readonly Challenge[],
): Promise<SeedSummary> {
  validateCatalogue(catalogue);

  let criterionRows = 0;

  await client.transaction(async (tx) => {
    for (const challenge of catalogue) {
      const content = challengeContent(challenge);

      await tx
        .insert(challenges)
        .values({ id: challenge.id, ...content })
        .onConflictDoUpdate({
          target: challenges.id,
          // `id` stays out of the update set: it is the conflict key. `updatedAt` is
          // written explicitly so a reseed that changes nothing else still records
          // that the row was reconciled.
          set: { ...content, updatedAt: sql`now()` },
        });

      const criteria = criterionValues(challenge);
      criterionRows += criteria.length;

      await tx.delete(rubricCriteria).where(eq(rubricCriteria.challengeId, challenge.id));

      // Safe from conflict because the row set for this challenge was just removed,
      // and `validateCatalogue` already proved the ids are unique within it.
      await tx.insert(rubricCriteria).values(criteria);
    }
  });

  return { challengeRows: catalogue.length, criterionRows };
}
