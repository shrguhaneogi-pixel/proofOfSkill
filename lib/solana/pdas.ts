/**
 * Single source of truth for every program address the client derives.
 *
 * Seeds mirror `programs/proof_of_skill/src/constants.rs` exactly:
 * `["config"]`, `["profile", user]`, `["credential", user, [challenge_id]]`.
 * `tests/proof_of_skill.ts` asserts parity with the addresses the program creates onchain.
 *
 * The address is derived with `findProgramAddressSync` (the bump is not read from an account),
 * so the returned bump is the canonical one. Accounts store their own `bump` field; the decoders
 * in `codecs.ts` surface it for callers that need the onchain value.
 */

import { PublicKey } from "@solana/web3.js";
import type { ChallengeId } from "../challenges/types";
import {
  CONFIG_SEED,
  CREDENTIAL_SEED,
  DEFAULT_PROGRAM_ID,
  PROFILE_SEED,
  UPGRADE_LOADER_PROGRAM_ID,
  isChallengeId,
} from "./constants";
import { parsePublicKey, toPublicKey } from "./codecs";

export type DerivedPda = {
  pda: PublicKey;
  bump: number;
};

let cachedProgramId: { raw: string; key: PublicKey } | undefined;

/**
 * `NEXT_PUBLIC_PROGRAM_ID`, falling back to the keypair this repo generated. An invalid value is
 * a configuration error, so it throws rather than silently deriving addresses for the wrong program.
 */
export function getProgramId(): PublicKey {
  const raw = (process.env.NEXT_PUBLIC_PROGRAM_ID ?? "").trim() || DEFAULT_PROGRAM_ID;
  if (cachedProgramId && cachedProgramId.raw === raw) {
    return cachedProgramId.key;
  }
  const parsed = parsePublicKey(raw);
  if (!parsed.ok) {
    throw new Error(`NEXT_PUBLIC_PROGRAM_ID is not a valid Solana address: ${parsed.error}`);
  }
  cachedProgramId = { raw, key: parsed.data };
  return cachedProgramId.key;
}

/** Seeds `["config"]`. */
export function configPda(programId: PublicKey = getProgramId()): DerivedPda {
  const [pda, bump] = PublicKey.findProgramAddressSync([CONFIG_SEED], programId);
  return { pda, bump };
}

/** Seeds `["profile", user]`. */
export function profilePda(
  user: PublicKey | string,
  programId: PublicKey = getProgramId(),
): DerivedPda {
  const userKey = toPublicKey(user);
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [PROFILE_SEED, userKey.toBytes()],
    programId,
  );
  return { pda, bump };
}

/** Seeds `["credential", user, [challenge_id]]` — the third seed is the single raw byte. */
export function credentialPda(
  user: PublicKey | string,
  challengeId: ChallengeId,
  programId: PublicKey = getProgramId(),
): DerivedPda {
  if (!isChallengeId(challengeId)) {
    throw new Error(`challenge id ${challengeId} is outside the onchain range 1..=5`);
  }
  const userKey = toPublicKey(user);
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [CREDENTIAL_SEED, userKey.toBytes(), Uint8Array.of(challengeId)],
    programId,
  );
  return { pda, bump };
}

/**
 * ProgramData account of an upgradeable program: one seed, the program id, owned by the
 * upgradeable loader. Only `initialize_config` needs it.
 */
export function programDataAddress(programId: PublicKey = getProgramId()): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [programId.toBytes()],
    toPublicKey(UPGRADE_LOADER_PROGRAM_ID),
  );
  return pda;
}
