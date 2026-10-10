/**
 * Where the challenge catalogue comes from: Postgres when it is configured, the
 * typed catalogue when it is not.
 *
 * `DATABASE_URL` is optional by design (see `.env.example`). Unset or blank means
 * `lib/challenges/data.ts` is the source of truth and the app behaves exactly as
 * it did before there was a database. Set means that table is the source of truth,
 * and this module stops treating the static catalogue as a safety net.
 *
 * Two decisions worth reading before changing anything here:
 *
 * **A configured database that fails is fatal, not a fallback.** If an operator
 * pointed the app at Postgres and the read throws, serving `data.ts` instead would
 * publish one rubric while the evaluator grades against another, and the candidate
 * has no way to notice. A 500 on the challenges page is recoverable and explains
 * itself; a credential the server believes is valid and the chain disagrees with is
 * the failure this repo treats as worst-case. So: `ChallengeSourceError`, thrown,
 * with the original error kept as `cause` and never inlined into the message (a
 * connection error can carry a host or a user).
 *
 * **Challenges change rarely, so one read serves many renders.** The catalogue is
 * read at most once per `CACHE_TTL_MS` per process and concurrent renders share the
 * in-flight promise, so a page render never pays a round trip per component. The
 * cache holds database reads only; the static path is a module constant already.
 * A failed read is evicted immediately so the next caller retries rather than
 * inheriting a sticky rejection.
 *
 * Server-only: it holds a connection pool. The synchronous `CHALLENGES`,
 * `findChallenge` and `findChallengeBySlug` in `lib/challenges/data.ts` are still
 * what client components import, and are unchanged.
 */
import "server-only";

import { asc } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { challenges, rubricCriteria, schema } from "../../db/schema.ts";
import { CHALLENGES } from "./data";
import {
  ChallengeRowsError,
  mapRowsToCatalogue,
  type CatalogueExclusion,
  type ChallengeRow,
  type MappedCatalogue,
  type RubricCriterionRow,
} from "./rows";
import type { Challenge } from "./types";

/**
 * Only `select` is used, so anything drizzle builds over this schema qualifies and
 * a test can hand over a fake with the same shape. Pass a full
 * `NodePgDatabase<typeof schema>` in production.
 */
export type ChallengesClient = Pick<NodePgDatabase<typeof schema>, "select">;

export type ChallengeSourceOrigin = "database" | "static";

export type ChallengeSource = {
  readonly origin: ChallengeSourceOrigin;
  /**
   * Shared between callers on purpose — the whole point is that a page render does
   * not re-read it. Treat it as read-only.
   */
  readonly challenges: readonly Challenge[];
  /**
   * Catalogue rows the loader left out, with the reason. Empty on every healthy
   * path; a non-empty list means the table holds a row the program cannot address.
   */
  readonly warnings: readonly CatalogueExclusion[];
};

/** Thrown when a configured database could not produce a usable catalogue. */
export class ChallengeSourceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ChallengeSourceError";
  }
}

/** Five minutes: long enough that a busy catalogue is one read, short enough that a seed is visible without a restart. */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** The catalogue is small and reads are cached, so the pool stays deliberately tiny. */
const POOL_MAX_CONNECTIONS = 2;

/**
 * A Postgres that is up but unreachable would otherwise hang the render on
 * libpq's default (no) timeout. Failing fast is what makes the typed error above
 * arrive instead of a request that never returns.
 */
const POOL_CONNECT_TIMEOUT_MS = 5_000;

type CacheSlot = {
  readonly generation: number;
  /** The client the slot was read from, so a different client is never served it. */
  readonly client: ChallengesClient;
  readonly expiresAt: number;
  readonly value: Promise<ChallengeSource>;
};

let cacheSlot: CacheSlot | null = null;
let cacheGeneration = 0;

type PooledClient = {
  readonly connectionString: string;
  readonly pool: Pool;
  readonly client: NodePgDatabase<typeof schema>;
};

let pooledClient: PooledClient | null = null;

function staticSource(): ChallengeSource {
  return { origin: "static", challenges: CHALLENGES, warnings: [] };
}

/**
 * `DATABASE_URL`, or `null` when it is absent *or blank*. A blank value in
 * `.env.local` means "not configured", matching how `lib/env.server.ts` reads
 * every other key — it is not reported as an error, because unset is the
 * supported default.
 */
export function databaseUrlFrom(source: Readonly<Record<string, string | undefined>>): string | null {
  const raw = source["DATABASE_URL"];
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/** The dedicated pool for catalogue reads. Creates no connection until the first query. */
export function createChallengePool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    max: POOL_MAX_CONNECTIONS,
    connectionTimeoutMillis: POOL_CONNECT_TIMEOUT_MS,
  });
}

/**
 * Builds a client over the catalogue schema. Constructing it opens no connection:
 * `pg` connects on the first query, so this is safe to call from a server module
 * and safe to assert on in a test.
 */
export function createChallengesClient(connectionString: string): NodePgDatabase<typeof schema> {
  return drizzle(createChallengePool(connectionString), { schema });
}

function clientFor(connectionString: string): NodePgDatabase<typeof schema> {
  if (pooledClient !== null && pooledClient.connectionString === connectionString) {
    return pooledClient.client;
  }
  const pool = createChallengePool(connectionString);
  // A changed URL means a new pool; the previous one is only released by
  // `resetChallengeSource({ closePool: true })`, which the seed script calls.
  pooledClient = { connectionString, pool, client: drizzle(pool, { schema }) };
  return pooledClient.client;
}

async function readCatalogue(client: ChallengesClient): Promise<ChallengeSource> {
  let challengeRows: readonly ChallengeRow[];
  let criterionRows: readonly RubricCriterionRow[];

  try {
    challengeRows = await client.select().from(challenges).orderBy(asc(challenges.id));
    criterionRows = await client
      .select()
      .from(rubricCriteria)
      .orderBy(asc(rubricCriteria.challengeId), asc(rubricCriteria.ordinal));
  } catch (cause) {
    throw new ChallengeSourceError(
      "Could not read the challenge catalogue from the configured database. Check DATABASE_URL and " +
        "apply drizzle/migrations with `pnpm exec drizzle-kit push`. The static catalogue in " +
        "lib/challenges/data.ts was not substituted for it on purpose: grading against a rubric the " +
        "page did not show would issue a credential nobody agreed to.",
      { cause },
    );
  }

  if (challengeRows.length === 0) {
    throw new ChallengeSourceError(
      "DATABASE_URL is set but the challenges table is empty. Seed it with `node scripts/seed-challenges.ts`. " +
        "An empty catalogue is not treated as the static one.",
    );
  }

  let mapped: MappedCatalogue;
  try {
    mapped = mapRowsToCatalogue(challengeRows, criterionRows);
  } catch (cause) {
    if (cause instanceof ChallengeRowsError) {
      throw new ChallengeSourceError(
        `The challenge rows in the configured database are not usable (${cause.reasons.join("; ")}). ` +
          "Reseed with `node scripts/seed-challenges.ts` or fix the rows.",
        { cause },
      );
    }
    throw cause;
  }

  if (mapped.excluded.length > 0) {
    // Once per cache fill, not once per render: the cache is what keeps this log
    // readable while still putting the problem in front of an operator.
    console.warn(
      "[challenges] left out of the catalogue:",
      mapped.excluded.map((exclusion) => exclusion.reason),
    );
  }

  return { origin: "database", challenges: mapped.challenges, warnings: mapped.excluded };
}

/**
 * Cached database read with in-flight de-duplication. Rejections are evicted so a
 * caller after a failure retries instead of awaiting the same rejected promise for
 * the rest of the TTL.
 */
function cachedCatalogue(client: ChallengesClient): Promise<ChallengeSource> {
  const now = Date.now();
  if (cacheSlot !== null && cacheSlot.client === client && cacheSlot.expiresAt > now) {
    return cacheSlot.value;
  }

  const generation = ++cacheGeneration;
  const value = readCatalogue(client);
  cacheSlot = { generation, client, expiresAt: now + CACHE_TTL_MS, value };

  value.catch(() => {
    // Only clear our own slot: a newer read may already have replaced it.
    if (cacheSlot !== null && cacheSlot.generation === generation) {
      cacheSlot = null;
    }
  });

  return value;
}

/**
 * The catalogue, from Postgres when `client` is supplied and from `data.ts` when
 * it is not. Never throws for a missing client — that is the unconfigured state —
 * but does throw (`ChallengeSourceError`) when a client was given and could not
 * produce a usable catalogue.
 */
export async function loadChallenges(client?: ChallengesClient | null): Promise<ChallengeSource> {
  if (client === undefined || client === null) {
    return staticSource();
  }
  return cachedCatalogue(client);
}

/**
 * `loadChallenges` with the decision made from the environment: use the database
 * when `DATABASE_URL` is configured, otherwise the static catalogue. This is what
 * a server component or route should call.
 */
export async function getChallengeSource(): Promise<ChallengeSource> {
  const connectionString = databaseUrlFrom(process.env);
  if (connectionString === null) {
    return staticSource();
  }
  return cachedCatalogue(clientFor(connectionString));
}

/**
 * Drops the cached catalogue (and, with `closePool`, the connection pool). The
 * seed script calls it so a read right after seeding sees the new rows rather than
 * a slot from before the write.
 */
export async function resetChallengeSource(options: { closePool?: boolean } = {}): Promise<void> {
  cacheSlot = null;
  ++cacheGeneration;

  if (options.closePool === true && pooledClient !== null) {
    const { pool } = pooledClient;
    pooledClient = null;
    await pool.end();
  }
}
