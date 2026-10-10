/**
 * Seeds the Postgres challenge catalogue from the typed one.
 *
 *   node scripts/seed-challenges.ts
 *
 * Node 24 strips the types itself, so there is no build step and no ts-node —
 * which is why the relative imports below carry `.ts` extensions and why this file
 * avoids enums, parameter properties and namespaces (all erasable syntax only).
 *
 * It is safe to run more than once: every statement is keyed by primary key and
 * the whole catalogue lands in one transaction (see `lib/challenges/seed.ts`).
 *
 * `DATABASE_URL` is read from the environment first, then from `.env.local` and
 * `.env` in the working directory, which are loaded only for keys the shell did
 * not already set. With no URL anywhere the script explains what to do and exits 1
 * instead of guessing: an unset `DATABASE_URL` is a supported configuration, not an
 * error — it means the app keeps serving `lib/challenges/data.ts`.
 */

// The loader in `lib/challenges/source.ts` is `server-only`, and that package
// throws when imported outside a React server graph — so this script builds its
// own client rather than borrowing the app's.
import { drizzle } from "drizzle-orm/node-postgres";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

import { schema } from "../db/schema.ts";
import { CHALLENGES } from "../lib/challenges/data.ts";
import { seedChallenges } from "../lib/challenges/seed.ts";

const ENV_FILES = [".env.local", ".env"];

/** Same bounds the app's catalogue pool uses, for one short-lived script. */
const POOL_MAX_CONNECTIONS = 2;
const POOL_CONNECT_TIMEOUT_MS = 5_000;

/**
 * Loads `.env.local`/`.env` into `process.env` without letting a file shadow what
 * the operator passed on the command line, and without failing when a file is
 * absent — `.env` usually is, and `.env.local` is gitignored.
 */
function loadEnvFiles(): void {
  if (typeof process.loadEnvFile !== "function") {
    // Node before 20.12 has no `loadEnvFile`; the variable still works if it is
    // genuinely in the environment.
    return;
  }
  const urlFromShell = process.env["DATABASE_URL"];
  for (const file of ENV_FILES) {
    try {
      process.loadEnvFile(file);
    } catch {
      // File missing or unreadable: nothing to load from it.
    }
  }
  if (urlFromShell !== undefined) {
    process.env["DATABASE_URL"] = urlFromShell;
  }
}

function databaseUrl(): string | null {
  const raw = process.env["DATABASE_URL"];
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

const NOT_CONFIGURED =
  "DATABASE_URL is not set, so there is no database to seed. Set it in .env.local " +
  "(for example postgres://user:password@localhost:5432/proof_of_skill) or export it in the shell, " +
  "apply the schema first with `pnpm exec drizzle-kit push`, then run this script again.\n" +
  "Leaving it unset is supported: the app serves the typed catalogue in lib/challenges/data.ts and " +
  "needs no database.";

async function main(): Promise<void> {
  loadEnvFiles();

  const connectionString = databaseUrl();
  if (connectionString === null) {
    throw new Error(NOT_CONFIGURED);
  }

  const pool = new Pool({
    connectionString,
    max: POOL_MAX_CONNECTIONS,
    connectionTimeoutMillis: POOL_CONNECT_TIMEOUT_MS,
  });

  try {
    const summary = await seedChallenges(drizzle(pool, { schema }), CHALLENGES);
    console.log(
      `Seeded ${String(summary.challengeRows)} challenges and ` +
        `${String(summary.criterionRows)} rubric criteria.`,
    );
    console.log(
      "Challenge ids are the onchain contract (MIN_CHALLENGE_ID..=MAX_CHALLENGE_ID in " +
        "programs/proof_of_skill/src/constants.rs): changing one here without redeploying the program " +
        "makes issuance fail.",
    );
  } finally {
    await pool.end();
  }
}

/**
 * True only when this file is the module `node` was asked to run, so the tests can
 * import the exports without executing a CLI against a real database.
 */
function isCliEntry(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) {
    return false;
  }
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isCliEntry()) {
  await main().catch((error: unknown) => {
    // Only the message is printed: a driver error can quote the host and the user,
    // and a stack would add nothing an operator can act on.
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
