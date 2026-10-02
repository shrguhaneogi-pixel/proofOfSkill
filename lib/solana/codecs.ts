/**
 * Borsh codecs for the `proof_of_skill` program: instruction data encoding and account decoding.
 *
 * There is no IDL on this host, so the layouts are written out here from
 * `programs/proof_of_skill/src/{instructions,state}/*.rs`. Every account field is fixed size
 * (Pubkey / integer / `[u8; 32]`) — no strings or `Vec`s — so `DataView` with little-endian
 * reads reproduces `borsh` exactly.
 *
 * Decoding is for untrusted RPC bytes, so it returns typed results and fails loudly on a
 * discriminator or length mismatch instead of returning a half-populated object.
 */

import { PublicKey } from "@solana/web3.js";
import base58 from "bs58";
import { bytesToHex, hexToBytes } from "../hashing/evidence-hash";
import {
  ACCOUNT_DISCRIMINATORS,
  ACCOUNT_DISCRIMINATOR_HEX,
  CONFIG_ACCOUNT_SIZE,
  CREDENTIAL_ACCOUNT_SIZE,
  DISCRIMINATOR_LENGTH,
  EVIDENCE_HASH_LENGTH,
  INSTRUCTION_DISCRIMINATORS,
  MAX_CHALLENGE_ID,
  MAX_SCORE,
  PASS_THRESHOLD,
  PUBLIC_KEY_LENGTH,
  USER_PROFILE_ACCOUNT_SIZE,
  type AccountName,
  isChallengeId,
} from "./constants";

export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export type ConfigAccount = {
  admin: PublicKey;
  issuer: PublicKey;
  bump: number;
};

export type UserProfileAccount = {
  user: PublicKey;
  /** Rust `i64`; kept as `bigint` because the full range is not representable as a JS number. */
  createdAt: bigint;
  completedCount: number;
  reputation: number;
  bump: number;
};

export type CredentialAccount = {
  user: PublicKey;
  issuer: PublicKey;
  evidenceHash: Uint8Array;
  /** Rust `i64` unix seconds; `Number(issuedAt) * 1000` is safe for any real timestamp. */
  issuedAt: bigint;
  challengeId: number;
  score: number;
  bump: number;
};

export type IssueCredentialArgs = {
  challengeId: number;
  score: number;
  evidenceHash: Uint8Array;
};

const BASE58_PATTERN = /^[1-9A-HJ-NP-Za-km-z]+$/;
const EVIDENCE_HASH_HEX_PATTERN = /^[0-9a-fA-F]{64}$/;

/** Parse an untrusted base58 address. Use this before any value that came from a client or a URL. */
export function parsePublicKey(value: string): Result<PublicKey> {
  if (!BASE58_PATTERN.test(value)) {
    return { ok: false, error: "address is not a base58 string" };
  }
  const bytes = base58.decode(value);
  if (bytes.length !== PUBLIC_KEY_LENGTH) {
    return { ok: false, error: `address must decode to ${PUBLIC_KEY_LENGTH} bytes, got ${bytes.length}` };
  }
  try {
    return { ok: true, data: new PublicKey(bytes) };
  } catch (error) {
    return { ok: false, error: `invalid address: ${describeError(error)}` };
  }
}

/** Convenience for code paths that already validated their input. Throws on a bad address string. */
export function toPublicKey(value: PublicKey | string): PublicKey {
  if (typeof value !== "string") {
    return value;
  }
  const parsed = parsePublicKey(value);
  if (!parsed.ok) {
    throw new Error(`invalid Solana address (${parsed.error})`);
  }
  return parsed.data;
}

export function evidenceHashFromHex(hex: string): Result<Uint8Array> {
  if (!EVIDENCE_HASH_HEX_PATTERN.test(hex)) {
    return { ok: false, error: "evidence hash must be 64 hexadecimal characters" };
  }
  return { ok: true, data: hexToBytes(hex) };
}

export function evidenceHashToHex(evidenceHash: Uint8Array): string {
  return bytesToHex(evidenceHash);
}

/** `initialize_config(issuer: Pubkey)` — discriminator + 32 raw bytes. */
export function encodeInitializeConfigData(issuer: PublicKey): Uint8Array {
  const data = allocInstructionData(INSTRUCTION_DISCRIMINATORS.initializeConfig, PUBLIC_KEY_LENGTH);
  data.set(issuer.toBytes(), DISCRIMINATOR_LENGTH);
  return data;
}

/** `initialize_profile()` takes no arguments, so the payload is the discriminator alone. */
export function encodeInitializeProfileData(): Uint8Array {
  return allocInstructionData(INSTRUCTION_DISCRIMINATORS.initializeProfile, 0);
}

/**
 * `issue_credential(challenge_id: u8, score: u8, evidence_hash: [u8; 32])`.
 *
 * The program's `require!` checks are mirrored here so a submission that is certain to revert
 * never costs the user a transaction fee.
 */
export function encodeIssueCredentialData(args: IssueCredentialArgs): Result<Uint8Array> {
  if (!isChallengeId(args.challengeId)) {
    return { ok: false, error: `challenge id must be an integer between 1 and ${MAX_CHALLENGE_ID}` };
  }
  if (!Number.isInteger(args.score) || args.score > MAX_SCORE) {
    return { ok: false, error: `score must be a whole number between 0 and ${MAX_SCORE}` };
  }
  if (args.score < PASS_THRESHOLD) {
    return { ok: false, error: `score ${args.score} is below the passing threshold of ${PASS_THRESHOLD}` };
  }
  if (args.evidenceHash.length !== EVIDENCE_HASH_LENGTH) {
    return {
      ok: false,
      error: `evidence hash must be ${EVIDENCE_HASH_LENGTH} bytes, got ${args.evidenceHash.length}`,
    };
  }
  if (args.evidenceHash.every((byte) => byte === 0)) {
    return { ok: false, error: "evidence hash must not be all zero bytes" };
  }

  const payloadLength = 1 + 1 + EVIDENCE_HASH_LENGTH;
  const data = allocInstructionData(INSTRUCTION_DISCRIMINATORS.issueCredential, payloadLength);
  const offset = DISCRIMINATOR_LENGTH;
  data[offset] = args.challengeId;
  data[offset + 1] = args.score;
  data.set(args.evidenceHash, offset + 2);
  return { ok: true, data };
}

export function decodeConfigAccount(data: Uint8Array): Result<ConfigAccount> {
  const view = prepareAccountData("config", CONFIG_ACCOUNT_SIZE, data);
  if (!view.ok) {
    return view;
  }
  return {
    ok: true,
    data: {
      admin: readPublicKey(view.data, DISCRIMINATOR_LENGTH),
      issuer: readPublicKey(view.data, DISCRIMINATOR_LENGTH + PUBLIC_KEY_LENGTH),
      bump: view.data.getUint8(DISCRIMINATOR_LENGTH + PUBLIC_KEY_LENGTH * 2),
    },
  };
}

export function decodeUserProfileAccount(data: Uint8Array): Result<UserProfileAccount> {
  const view = prepareAccountData("userProfile", USER_PROFILE_ACCOUNT_SIZE, data);
  if (!view.ok) {
    return view;
  }
  const body = view.data;
  return {
    ok: true,
    data: {
      user: readPublicKey(body, DISCRIMINATOR_LENGTH),
      createdAt: body.getBigInt64(DISCRIMINATOR_LENGTH + PUBLIC_KEY_LENGTH, true),
      completedCount: body.getUint32(DISCRIMINATOR_LENGTH + PUBLIC_KEY_LENGTH + 8, true),
      reputation: body.getUint32(DISCRIMINATOR_LENGTH + PUBLIC_KEY_LENGTH + 12, true),
      bump: body.getUint8(USER_PROFILE_ACCOUNT_SIZE - 1),
    },
  };
}

export function decodeCredentialAccount(data: Uint8Array): Result<CredentialAccount> {
  const view = prepareAccountData("credential", CREDENTIAL_ACCOUNT_SIZE, data);
  if (!view.ok) {
    return view;
  }
  const body = view.data;
  let offset = DISCRIMINATOR_LENGTH;
  const user = readPublicKey(body, offset);
  offset += PUBLIC_KEY_LENGTH;
  const issuer = readPublicKey(body, offset);
  offset += PUBLIC_KEY_LENGTH;
  const evidenceHash = copyBytes(body, offset, EVIDENCE_HASH_LENGTH);
  offset += EVIDENCE_HASH_LENGTH;
  const issuedAt = body.getBigInt64(offset, true);
  offset += 8;
  const challengeId = body.getUint8(offset);
  offset += 1;
  const score = body.getUint8(offset);
  const bump = body.getUint8(offset + 1);

  // A value the program cannot write means the bytes are not a Credential, whatever the
  // discriminator said.
  if (!isChallengeId(challengeId)) {
    return { ok: false, error: `credential account holds out-of-range challenge id ${challengeId}` };
  }
  if (score > MAX_SCORE) {
    return { ok: false, error: `credential account holds impossible score ${score}` };
  }

  return { ok: true, data: { user, issuer, evidenceHash, issuedAt, challengeId, score, bump } };
}

function allocInstructionData(discriminator: Uint8Array, payloadLength: number): Uint8Array {
  const data = new Uint8Array(DISCRIMINATOR_LENGTH + payloadLength);
  data.set(discriminator, 0);
  return data;
}

function prepareAccountData(account: AccountName, size: number, data: Uint8Array): Result<DataView> {
  if (data.length !== size) {
    return { ok: false, error: `${account} account must be ${size} bytes, got ${data.length}` };
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const discriminator = new Uint8Array(view.buffer, view.byteOffset, DISCRIMINATOR_LENGTH);
  const expected = ACCOUNT_DISCRIMINATORS[account];
  for (let index = 0; index < DISCRIMINATOR_LENGTH; index += 1) {
    if (discriminator[index] !== expected[index]) {
      return {
        ok: false,
        error: `${account} discriminator mismatch: expected ${ACCOUNT_DISCRIMINATOR_HEX[account]}, got ${bytesToHex(discriminator)}`,
      };
    }
  }
  return { ok: true, data: view };
}

function readPublicKey(view: DataView, offset: number): PublicKey {
  const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, PUBLIC_KEY_LENGTH);
  return new PublicKey(bytes.slice());
}

function copyBytes(view: DataView, offset: number, length: number): Uint8Array {
  return new Uint8Array(view.buffer.slice(view.byteOffset + offset, view.byteOffset + offset + length));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
