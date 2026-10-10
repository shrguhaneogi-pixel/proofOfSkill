// `server-only` resolves to a throwing stub outside a React Server bundler, so
// vitest has to replace it before this module is imported.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { challenges } from "../../db/schema.ts";
import { CHALLENGES } from "./data";
import type { ChallengeRow, RubricCriterionRow } from "./rows";
import {
  ChallengeSourceError,
  createChallengePool,
  createChallengesClient,
  databaseUrlFrom,
  getChallengeSource,
  loadChallenges,
  resetChallengeSource,
  type ChallengesClient,
} from "./source";

vi.mock("server-only", () => ({ default: {} }));

const STAMP = new Date("2026-01-01T00:00:00.000Z");

function rowOf(index: number): ChallengeRow {
  const challenge = CHALLENGES[index];
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

function criteriaOf(index: number): RubricCriterionRow[] {
  const challenge = CHALLENGES[index];
  return challenge.rubric.map((criterion, ordinal) => ({
    challengeId: challenge.id,
    id: criterion.id,
    label: criterion.label,
    weight: criterion.weight,
    ordinal,
  }));
}

function rowsFor(count: number): {
  challengeRows: ChallengeRow[];
  criterionRows: RubricCriterionRow[];
} {
  const indexes = [...Array(count).keys()];
  return {
    challengeRows: indexes.map(rowOf),
    criterionRows: indexes.flatMap(criteriaOf),
  };
}

type FakeClient = { client: ChallengesClient; queryCount: () => number };

/**
 * Stands in for a `NodePgDatabase`: one `select()` per statement, and the read is
 * decided by which table the query is `from`. The second statement is never
 * reached when the first rejects, which is what the query counts below assert.
 */
function fakeClient(
  challengeRows: readonly ChallengeRow[],
  criterionRows: readonly RubricCriterionRow[],
  options: { fail?: boolean } = {},
): FakeClient {
  let queries = 0;

  const client = {
    select: () => {
      queries += 1;
      return {
        from: (table: unknown) => ({
          orderBy: () =>
            options.fail === true
              ? Promise.reject(new Error("connection terminated unexpectedly"))
              : Promise.resolve(table === challenges ? [...challengeRows] : [...criterionRows]),
        }),
      };
    },
  };

  return { client: client as unknown as ChallengesClient, queryCount: () => queries };
}

const fullCatalogue = rowsFor(CHALLENGES.length);

describe("loadChallenges", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    await resetChallengeSource({ closePool: true });
    vi.useRealTimers();
  });

  it("returns the static catalogue when no client is supplied", async () => {
    const source = await loadChallenges();

    expect(source.origin).toBe("static");
    expect(source.challenges).toEqual(CHALLENGES);
    expect(source.warnings).toEqual([]);
  });

  it("accepts an explicit null as the unconfigured case", async () => {
    const source = await loadChallenges(null);
    expect(source.origin).toBe("static");
  });

  it("maps database rows into the same shape the static catalogue has", async () => {
    const fake = fakeClient(fullCatalogue.challengeRows, fullCatalogue.criterionRows);

    const source = await loadChallenges(fake.client);

    expect(source.origin).toBe("database");
    expect(source.challenges).toEqual(CHALLENGES);
    expect(source.warnings).toEqual([]);
    expect(fake.queryCount()).toBe(2);
  });

  it("serves a second call from the cache instead of re-reading", async () => {
    const fake = fakeClient(fullCatalogue.challengeRows, fullCatalogue.criterionRows);

    const first = await loadChallenges(fake.client);
    const second = await loadChallenges(fake.client);

    expect(second.challenges).toEqual(first.challenges);
    expect(fake.queryCount()).toBe(2);
  });

  it("shares one in-flight read across concurrent callers", async () => {
    const fake = fakeClient(fullCatalogue.challengeRows, fullCatalogue.criterionRows);

    const [first, second] = await Promise.all([
      loadChallenges(fake.client),
      loadChallenges(fake.client),
    ]);

    expect(first).toBe(second);
    expect(fake.queryCount()).toBe(2);
  });

  it("never serves one client's cache to a different client", async () => {
    await loadChallenges(fakeClient(fullCatalogue.challengeRows, fullCatalogue.criterionRows).client);

    const other = fakeClient([rowOf(0)], criteriaOf(0));
    const source = await loadChallenges(other.client);

    expect(source.challenges.map((challenge) => challenge.id)).toEqual([1]);
    expect(other.queryCount()).toBe(2);
  });

  it("re-reads once the cache expires", async () => {
    const fake = fakeClient(fullCatalogue.challengeRows, fullCatalogue.criterionRows);
    await loadChallenges(fake.client);

    vi.useFakeTimers();
    vi.advanceTimersByTime(6 * 60 * 1000);
    await loadChallenges(fake.client);
    vi.useRealTimers();

    expect(fake.queryCount()).toBe(4);
  });

  it("re-reads after an explicit reset", async () => {
    const fake = fakeClient(fullCatalogue.challengeRows, fullCatalogue.criterionRows);
    await loadChallenges(fake.client);

    await resetChallengeSource();
    await loadChallenges(fake.client);

    expect(fake.queryCount()).toBe(4);
  });

  it("fails loudly instead of falling back when the read throws", async () => {
    const fake = fakeClient([], [], { fail: true });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(loadChallenges(fake.client)).rejects.toThrow(ChallengeSourceError);
    await expect(loadChallenges(fake.client)).rejects.toThrowError(
      /Could not read the challenge catalogue/,
    );
    expect(warning).not.toHaveBeenCalled();
  });

  it("does not cache a failure, so the next caller retries", async () => {
    const fake = fakeClient([], [], { fail: true });

    await expect(loadChallenges(fake.client)).rejects.toThrow(ChallengeSourceError);
    await expect(loadChallenges(fake.client)).rejects.toThrow(ChallengeSourceError);

    // One statement per attempt: the first query throws, so the second is never issued.
    expect(fake.queryCount()).toBe(2);
  });

  it("keeps the driver error available without putting it in the message", async () => {
    const fake = fakeClient([], [], { fail: true });

    const error = await loadChallenges(fake.client).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ChallengeSourceError);
    const cause = (error as ChallengeSourceError).cause;
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toBe("connection terminated unexpectedly");
  });

  it("treats an empty table as a configuration error, not the static catalogue", async () => {
    const fake = fakeClient([], []);

    await expect(loadChallenges(fake.client)).rejects.toThrowError(
      /challenges table is empty[\s\S]*seed-challenges\.ts/,
    );
  });

  it("wraps an unusable row set with the reason and the reseed instruction", async () => {
    const fake = fakeClient([rowOf(0)], criteriaOf(0).slice(0, 3));

    await expect(loadChallenges(fake.client)).rejects.toThrowError(
      /not usable[\s\S]*weights sum to 80[\s\S]*Reseed/,
    );
  });

  it("reports a row the program cannot address as a warning and keeps the rest", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const outOfRange: ChallengeRow = { ...rowOf(0), id: 6, slug: "not-onchain" };
    const fake = fakeClient(
      [outOfRange, ...fullCatalogue.challengeRows.slice(1)],
      [
        ...criteriaOf(0).map((row) => ({ ...row, challengeId: 6 })),
        ...fullCatalogue.criterionRows.filter((row) => row.challengeId !== 1),
      ],
    );

    const source = await loadChallenges(fake.client);

    expect(source.origin).toBe("database");
    expect(source.warnings.map((exclusion) => exclusion.challengeId)).toEqual([6]);
    expect(source.challenges.map((challenge) => challenge.id)).toEqual([2, 3, 4, 5]);
    // Warned once for the cache fill, not once per caller.
    expect(warning).toHaveBeenCalledTimes(1);
  });
});

describe("databaseUrlFrom", () => {
  it("reads unset, blank and whitespace-only as not configured", () => {
    expect(databaseUrlFrom({})).toBeNull();
    expect(databaseUrlFrom({ DATABASE_URL: undefined })).toBeNull();
    expect(databaseUrlFrom({ DATABASE_URL: "" })).toBeNull();
    expect(databaseUrlFrom({ DATABASE_URL: "   " })).toBeNull();
  });

  it("keeps a configured URL", () => {
    expect(databaseUrlFrom({ DATABASE_URL: " postgres://localhost:5432/db " })).toBe(
      "postgres://localhost:5432/db",
    );
  });
});

describe("getChallengeSource", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    await resetChallengeSource({ closePool: true });
  });

  it("uses the static catalogue while DATABASE_URL is blank", async () => {
    vi.stubEnv("DATABASE_URL", "");

    const source = await getChallengeSource();

    expect(source.origin).toBe("static");
    expect(source.challenges).toEqual(CHALLENGES);
  });

  it("fails with a typed error instead of the static catalogue once it is set", async () => {
    // Port 1 refuses immediately, so this is the real driver path: a configured
    // database that cannot be reached has to surface, not quietly become data.ts.
    vi.stubEnv("DATABASE_URL", "postgres://nobody@127.0.0.1:1/nope");

    await expect(getChallengeSource()).rejects.toThrow(ChallengeSourceError);
  }, 20_000);
});

describe("createChallengesClient", () => {
  it("builds a pool and a client without opening a connection", () => {
    const pool = createChallengePool("postgres://nobody@127.0.0.1:1/nope");
    const client = createChallengesClient("postgres://nobody@127.0.0.1:1/nope");

    expect(typeof client.select).toBe("function");
    // Counting properties prove the claim that matters: building a client is not
    // the same as reaching a database. `pg` has no `pendingCount`; `waitingCount` is
    // the one that reports queued acquire requests.
    expect(pool.totalCount).toBe(0);
    expect(pool.idleCount).toBe(0);
    expect(pool.waitingCount).toBe(0);
  });
});
