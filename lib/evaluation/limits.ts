/**
 * Submission bounds, shared verbatim between the client form and the server
 * schema so validation cannot drift between the two halves (docs/styleguide.md →
 * REACT_NEXT: "zod validation shared with the API schema").
 *
 * Values come from docs/api-schema.md → SUBMISSION. This module is intentionally
 * dependency-free: `components/` and `lib/` both import it without pulling in zod
 * or the evaluator's transport types.
 */

/** Trimmed length window for the written explanation, in characters. */
export const EXPLANATION_RANGE = { min: 100, max: 4000 } as const;

/** Length window for the pasted code, in characters, measured after trimming. */
export const CODE_RANGE = { min: 1, max: 8000 } as const;

/**
 * A public GitHub repository, `https://github.com/owner/repo`, with an optional trailing
 * slash. Nothing else is accepted: no other host, no `http:`, no deep links into a tree.
 *
 * This URL *is* now read server-side — `lib/evaluation/github.ts` walks the repository
 * tree through the GitHub API and feeds bounded file excerpts to the evaluator — so the
 * shape enforced here is a security boundary, not just a validation nicety. Keep the two
 * caveats together:
 *
 * - `[\w.-]+` matches dot-segments, so `..` passes this pattern. `github.ts` re-parses and
 *   rejects those before any request; do not treat this regex as path-safe on its own.
 * - Fetching is capped (per-file size, file count, total bytes, blob reads) and the
 *   evidence hash folds in a digest of what was read, so grading stays reproducible.
 *   See `docs/rules.md` → FORBIDDEN_PRACTICES for the "no arbitrary user-supplied URLs"
 *   rule this operates inside.
 */
export const REPO_URL_PATTERN = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/;

/** The five catalogue entries the onchain program can issue credentials for. */
export const CHALLENGE_ID_RANGE = { min: 1, max: 5 } as const;
