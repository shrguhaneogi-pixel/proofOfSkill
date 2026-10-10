import { defineConfig } from "drizzle-kit";

/**
 * Drizzle config for the challenge catalogue.
 *
 * `pnpm exec drizzle-kit generate` is offline — it only reads `schema` and diffs it
 * against the migrations already in `out`, so the SQL under `drizzle/migrations` is
 * reviewable with no database anywhere. `push` and `migrate` are the commands that
 * connect, and they take their connection from `dbCredentials` here rather than from
 * the environment on their own — which is why the URL is wired even though this
 * project has no database on the machine where the schema was written.
 *
 * `DATABASE_URL` is optional in the app for the same reason it is optional here: with
 * no URL the catalogue stays the typed one in `lib/challenges/data.ts`. Falling back
 * to an empty string keeps `generate` working, and a `push` with no URL fails with
 * drizzle-kit's own connection message instead of a TypeScript-level `undefined`.
 * Never log this value — a Postgres URL can carry a password.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema.ts",
  out: "./drizzle/migrations",
  // drizzle-kit 0.21+ renamed this block to `dbCredentials`: `dbUrl` and a bare `db`
  // key are both type errors against its config union, which is what caught the old
  // spelling here.
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});
