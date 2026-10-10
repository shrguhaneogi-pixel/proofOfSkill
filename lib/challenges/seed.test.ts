import { describe, expect, it } from "vitest";

import { challenges, rubricCriteria } from "../../db/schema.ts";
import { CHALLENGES } from "./data";
import { ChallengeSeedError, seedChallenges, validateCatalogue, type SeedClient } from "./seed";
import type { Challenge } from "./types";

type CriterionWrite = {
  challengeId: number;
  id: string;
  label: string;
  weight: number;
  ordinal: number;
};

type ChallengeWrite = {
  id: number;
  content: Record<string, unknown>;
  target?: unknown;
  set?: Record<string, unknown>;
};

type Fake = {
  client: SeedClient;
  order: string[];
  challengeWrites: ChallengeWrite[];
  criteriaWrites: CriterionWrite[];
  /** What a database would hold after the statements recorded so far. */
  storedChallenges: Map<number, Record<string, unknown>>;
  storedCriteria: Map<string, CriterionWrite>;
  transactions: number;
};

/**
 * A stand-in for a drizzle client that records statements and applies them to two
 * maps, so idempotency is asserted on the resulting row set and not on the call
 * count alone.
 *
 * The `delete()` predicate is an opaque SQL object, so the fake clears a
 * challenge's criteria when its insert arrives — legitimate only because
 * `seed-challenges` emits delete-then-insert per challenge, which the `order`
 * assertions below are there to prove.
 */
function fakeClient(options: { rejectAt?: "delete" | "insert" } = {}): Fake {
  const order: string[] = [];
  const challengeWrites: ChallengeWrite[] = [];
  const criteriaWrites: CriterionWrite[] = [];
  const storedChallenges = new Map<number, Record<string, unknown>>();
  const storedCriteria = new Map<string, CriterionWrite>();
  let transactions = 0;
  // Set by `delete()` so the next criteria insert knows it is a replacement.
  let pendingDelete = false;

  const tx = {
    insert(table: unknown) {
      return {
        values(rows: unknown) {
          if (options.rejectAt === "insert") {
            return Promise.reject(new Error("insert rejected"));
          }
          const list = Array.isArray(rows) ? rows : [rows];

          if (table === challenges) {
            const first = list[0] as { id: number };
            const write: ChallengeWrite = { id: first.id, content: first as Record<string, unknown> };
            challengeWrites.push(write);
            order.push("challenge:upsert");
            const statement = Promise.resolve() as Promise<void> & {
              onConflictDoUpdate(config: { target: unknown; set: Record<string, unknown> }): Promise<void>;
            };
            statement.onConflictDoUpdate = (config) => {
              write.target = config.target;
              write.set = config.set;
              return Promise.resolve();
            };
            return statement;
          }

          if (table === rubricCriteria) {
            const rowsAsCriteria = list as CriterionWrite[];
            criteriaWrites.push(...rowsAsCriteria);
            order.push("criteria:insert");
            // The delete that precedes this statement is per challenge; the
            // challenge id is on every row, so clearing the same key is exact.
            const challengeId = rowsAsCriteria[0]?.challengeId;
            if (challengeId !== undefined && pendingDelete) {
              for (const key of [...storedCriteria.keys()]) {
                if (key.startsWith(`${String(challengeId)}:`)) {
                  storedCriteria.delete(key);
                }
              }
              pendingDelete = false;
            }
            for (const row of rowsAsCriteria) {
              storedCriteria.set(`${String(row.challengeId)}:${row.id}`, row);
            }
            return Promise.resolve();
          }

          throw new Error("insert on an unexpected table");
        },
      };
    },
    delete(table: unknown) {
      return {
        where: () => {
          if (options.rejectAt === "delete") {
            return Promise.reject(new Error("delete rejected"));
          }
          if (table !== rubricCriteria) {
            throw new Error("delete on an unexpected table");
          }
          pendingDelete = true;
          order.push("criteria:delete");
          return Promise.resolve();
        },
      };
    },
  };

  const client = {
    transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => {
      transactions += 1;
      await callback(tx);
      // Only a transaction that ran to the end commits.
      for (const write of challengeWrites) {
        const existing = storedChallenges.get(write.id) ?? {};
        storedChallenges.set(write.id, { ...existing, ...write.content, ...(write.set ?? {}) });
      }
      return undefined;
    },
  };

  return {
    client: client as unknown as SeedClient,
    order,
    challengeWrites,
    criteriaWrites,
    storedChallenges,
    storedCriteria,
    get transactions() {
      return transactions;
    },
  };
}

/** A catalogue copy with one challenge edited, without touching `data.ts`. */
function withChallenge(id: number, change: Partial<Challenge>): Challenge[] {
  return CHALLENGES.map((challenge) => (challenge.id === id ? { ...challenge, ...change } : challenge));
}

function seedError(run: () => unknown): ChallengeSeedError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ChallengeSeedError);
    return error as ChallengeSeedError;
  }
  throw new Error("expected a ChallengeSeedError");
}

describe("validateCatalogue", () => {
  it("accepts the catalogue as written in data.ts", () => {
    expect(() => validateCatalogue(CHALLENGES)).not.toThrow();
  });

  it("refuses a rubric that does not total 100", () => {
    const error = seedError(() =>
      validateCatalogue(
        withChallenge(1, {
          rubric: [
            { id: "alpha", label: "Alpha", weight: 60 },
            { id: "beta", label: "Beta", weight: 30 },
          ],
        }),
      ),
    );

    expect(error.reasons.join(" ")).toContain("challenge 1: rubric weights sum to 90");
  });

  it("refuses an id the onchain program cannot address", () => {
    const error = seedError(() => validateCatalogue([{ ...CHALLENGES[0], id: 6 as never }]));

    expect(error.reasons.join(" ")).toContain("outside the range the onchain program accepts");
  });

  it("refuses duplicate ids, duplicate slugs and a malformed slug", () => {
    const duplicate = seedError(() => validateCatalogue([CHALLENGES[0], CHALLENGES[0]]));
    expect(duplicate.reasons).toContain("challenge 1: duplicate id");
    expect(duplicate.reasons).toContain('challenge 1: duplicate slug "solana-pda-fundamentals"');

    const malformed = seedError(() => validateCatalogue(withChallenge(2, { slug: "Not A Slug" })));
    expect(malformed.reasons.join(" ")).toContain("is not kebab-case");
  });

  it("refuses a criterion id the database CHECK would reject", () => {
    const error = seedError(() =>
      validateCatalogue(
        withChallenge(1, {
          rubric: [
            { id: "Renamed Upstream", label: "Renamed", weight: 100 },
          ],
        }),
      ),
    );

    expect(error.reasons.join(" ")).toContain("is not snake_case");
  });

  it("refuses blank copy, an empty rubric and a zero-length estimate", () => {
    const empty = seedError(() => validateCatalogue([]));
    expect(empty.reasons).toEqual(["the catalogue is empty"]);

    const blank = seedError(() => validateCatalogue(withChallenge(3, { title: "  " })));
    expect(blank.reasons).toContain("challenge 3: blank title");

    const noRubric = seedError(() => validateCatalogue(withChallenge(4, { rubric: [] })));
    expect(noRubric.reasons).toContain("challenge 4: rubric is empty");

    const estimate = seedError(() => validateCatalogue(withChallenge(5, { estimatedMinutes: 0 })));
    expect(estimate.reasons).toContain("challenge 5: estimatedMinutes must be a positive integer");
  });
});

describe("seedChallenges", () => {
  it("writes every challenge as an upsert keyed by id", async () => {
    const fake = fakeClient();

    const summary = await seedChallenges(fake.client, CHALLENGES);

    expect(summary).toEqual({ challengeRows: 5, criterionRows: 20 });
    expect(fake.challengeWrites.map((write) => write.id)).toEqual([1, 2, 3, 4, 5]);
    for (const write of fake.challengeWrites) {
      expect(write.target).toBe(challenges.id);
      // The id is the conflict key, so it is never in the update set.
      expect(write.set).not.toHaveProperty("id");
      expect(write.set).toHaveProperty("updatedAt");
      expect(write.set).toHaveProperty("prompt");
    }
  });

  it("replaces each rubric in place, so a renamed criterion cannot linger", async () => {
    const fake = fakeClient();

    await seedChallenges(fake.client, CHALLENGES);

    expect(fake.order).toEqual([
      "challenge:upsert",
      "criteria:delete",
      "criteria:insert",
      "challenge:upsert",
      "criteria:delete",
      "criteria:insert",
      "challenge:upsert",
      "criteria:delete",
      "criteria:insert",
      "challenge:upsert",
      "criteria:delete",
      "criteria:insert",
      "challenge:upsert",
      "criteria:delete",
      "criteria:insert",
    ]);
  });

  it("stores the rubric order as the ordinal column", async () => {
    const fake = fakeClient();

    await seedChallenges(fake.client, CHALLENGES);

    const first = fake.criteriaWrites.filter((row) => row.challengeId === 1);
    expect(first.map((row) => row.ordinal)).toEqual([0, 1, 2, 3]);
    expect(first.map((row) => row.id)).toEqual(CHALLENGES[0].rubric.map((criterion) => criterion.id));
    expect(new Set(fake.criteriaWrites.map((row) => row.challengeId))).toEqual(new Set([1, 2, 3, 4, 5]));
  });

  it("is idempotent: a second run leaves the same rows and the same statements", async () => {
    const fake = fakeClient();

    const first = await seedChallenges(fake.client, CHALLENGES);
    const orderAfterFirst = [...fake.order];
    const challengesAfterFirst = new Map(fake.storedChallenges);
    const criteriaAfterFirst = new Map(fake.storedCriteria);

    const second = await seedChallenges(fake.client, CHALLENGES);

    expect(second).toEqual(first);
    expect(fake.order.slice(orderAfterFirst.length)).toEqual(orderAfterFirst);
    expect(fake.storedChallenges.size).toBe(5);
    expect(fake.storedCriteria.size).toBe(20);
    expect(fake.storedChallenges).toEqual(challengesAfterFirst);
    expect(fake.storedCriteria).toEqual(criteriaAfterFirst);
    expect(fake.transactions).toBe(2);
  });

  it("writes content that maps back to the catalogue it was given", async () => {
    const fake = fakeClient();

    await seedChallenges(fake.client, CHALLENGES);

    const stored = fake.storedChallenges.get(2) ?? {};
    expect(stored["slug"]).toBe("solana-transaction-analysis");
    expect(stored["difficulty"]).toBe("intermediate");
    expect(stored["category"]).toBe("Solana");
    expect(stored["estimatedMinutes"]).toBe(60);
    expect(stored["credentialType"]).toBe("solana-transaction-analysis");

    const rubric = [...fake.storedCriteria.values()]
      .filter((row) => row.challengeId === 2)
      .sort((left, right) => left.ordinal - right.ordinal);
    expect(rubric.reduce((sum, row) => sum + row.weight, 0)).toBe(100);
    expect(rubric.map((row) => [row.id, row.weight])).toEqual([
      ["account_roles", 30],
      ["blockhash_fees", 25],
      ["diagnosis", 25],
      ["clarity", 20],
    ]);
  });

  it("validates before touching the database", async () => {
    const fake = fakeClient();

    const attempt = seedChallenges(
      fake.client,
      withChallenge(1, { rubric: [{ id: "only", label: "Only", weight: 50 }] }),
    );

    await expect(attempt).rejects.toThrow(ChallengeSeedError);
    expect(fake.order).toEqual([]);
    expect(fake.transactions).toBe(0);
  });

  it("runs the whole catalogue in one transaction", async () => {
    const fake = fakeClient({ rejectAt: "delete" });

    await expect(seedChallenges(fake.client, CHALLENGES)).rejects.toThrow("delete rejected");
    // One transaction attempted; the statements that did run are rolled back by the
    // fake the same way Postgres would roll them back, so nothing is stored.
    expect(fake.transactions).toBe(1);
    expect(fake.storedChallenges.size).toBe(0);
    expect(fake.storedCriteria.size).toBe(0);
  });
});
