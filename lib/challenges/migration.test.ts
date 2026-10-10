import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { RUBRIC_TOTAL_POINTS } from "../../db/schema.ts";
import { CHALLENGES } from "./data";

const MIGRATIONS = "drizzle/migrations";

/**
 * The generated SQL is the artefact that will be applied to a real database, and no
 * database exists on this machine — so the assertions below are the only check that
 * the schema in `schema.ts` actually reached the file that gets deployed. They read
 * the SQL rather than trusting drizzle's in-memory model.
 */
function migrationSql(): string {
  const root = join(process.cwd(), MIGRATIONS);
  const files = readdirSync(root)
    .filter((name) => name.endsWith(".sql"))
    .filter((name) => statSync(join(root, name)).isFile());

  expect(files.length, `expected generated SQL under ${MIGRATIONS}/`).toBeGreaterThan(0);
  return files.map((name) => readFileSync(join(root, name), "utf8")).join("\n");
}

describe("generated migration SQL", () => {
  const sql = migrationSql();

  it("creates both catalogue tables", () => {
    expect(sql).toContain('CREATE TABLE "challenges"');
    expect(sql).toContain('CREATE TABLE "rubric_criteria"');
  });

  it("keys the challenge table on the onchain id, not a surrogate", () => {
    expect(sql).toMatch(/"id" smallint PRIMARY KEY/);
    expect(sql).not.toContain("serial");
    expect(sql).not.toContain("uuid");
  });

  it("binds the id to the range the program accepts, as literals and not parameters", () => {
    expect(sql).toContain('CONSTRAINT "challenges_id_in_program_range" CHECK ("challenges"."id" >= 1 AND "challenges"."id" <= 5)');
    // A `$1` in DDL is a migration that cannot be applied; drizzle emits one for any
    // value interpolated without `sql.raw`.
    expect(sql).not.toMatch(/\$\d/);
  });

  it("constrains weight per row, since a sum across rows is not expressible as a CHECK", () => {
    expect(sql).toContain('CONSTRAINT "rubric_criteria_weight_positive" CHECK ("rubric_criteria"."weight" > 0)');
    expect(sql).toContain(
      `CONSTRAINT "rubric_criteria_weight_within_total" CHECK ("rubric_criteria"."weight" <= ${String(RUBRIC_TOTAL_POINTS)})`,
    );
  });

  it("keeps a rubric's criteria unique by id and by position", () => {
    expect(sql).toContain('CONSTRAINT "rubric_criteria_challenge_id_id_pk" PRIMARY KEY("challenge_id","id")');
    expect(sql).toContain('CREATE UNIQUE INDEX "rubric_criteria_position_unique"');
  });

  it("makes a challenge's criteria belong to it, and follow it on delete", () => {
    expect(sql).toContain('FOREIGN KEY ("challenge_id") REFERENCES "public"."challenges"("id") ON DELETE cascade');
  });

  it("allows only the difficulties and categories the types allow", () => {
    expect(sql).toContain('CHECK ("challenges"."difficulty" IN (\'beginner\', \'intermediate\', \'advanced\'))');
    expect(sql).toContain('CHECK ("challenges"."category" IN (\'Solana\', \'Anchor\', \'Web3 Frontend\', \'Security\'))');
  });

  it("has no pass threshold or score ceiling column", () => {
    // `PASS_THRESHOLD` is a program constant; a mutable per-row copy would be a
    // second source of truth for a value the chain enforces.
    expect(sql).not.toMatch(/pass_threshold/);
    expect(sql).not.toMatch(/max_score/);
    expect(sql).not.toMatch(/max_points/);
  });

  it("holds the catalogue as written", () => {
    for (const challenge of CHALLENGES) {
      expect(challenge.rubric).toHaveLength(
        new Set(challenge.rubric.map((criterion) => criterion.id)).size,
      );
      expect(challenge.rubric.reduce((sum, criterion) => sum + criterion.weight, 0)).toBe(
        RUBRIC_TOTAL_POINTS,
      );
      // The values the CHECK constraints above would refuse.
      for (const criterion of challenge.rubric) {
        expect(criterion.id).toMatch(/^[a-z][a-z0-9_]{0,62}$/);
        expect(criterion.label.trim().length).toBeGreaterThan(0);
      }
      expect(challenge.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });
});
