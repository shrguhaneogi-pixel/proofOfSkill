/**
 * The single copy of the numbers the onchain program enforces.
 *
 * Mirrors `programs/proof_of_skill/src/constants.rs`. The Rust test module asserts the same values
 * on the other side, so a change that does not match the program is caught here rather than
 * surfacing as an attestation the chain rejects — the worst kind of drift, because the server
 * believes it issued a valid pass.
 *
 * Modules re-export these under their own names (`lib/solana/constants.ts`,
 * `lib/attestation/sign.ts`, `lib/evaluation/types.ts`) so the existing import sites and literal
 * types stay intact while one file owns the values.
 */

/** Matches `MIN_CHALLENGE_ID` in the program. */
export const MIN_CHALLENGE_ID = 1 as const;

/** Matches `MAX_CHALLENGE_ID` in the program. */
export const MAX_CHALLENGE_ID = 5 as const;

/** Matches `MAX_SCORE` in the program: the upper bound a score may ever take. */
export const MAX_SCORE = 100 as const;

/**
 * Matches `PASS_THRESHOLD` in the program. A credential can only exist when the score reaches
 * this, which is why there is no `passed` field onchain.
 */
export const PASS_THRESHOLD = 70 as const;
