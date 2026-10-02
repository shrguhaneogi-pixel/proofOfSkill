/**
 * Instruction assembly for the `proof_of_skill` program without an IDL or an Anchor `Program`.
 *
 * Account order and mutability here must equal the `#[derive(Accounts)]` struct field order in
 * `programs/proof_of_skill/src/instructions/*.rs`; the runtime rejects a reordered account list.
 * PDAs are passed in by the caller (`pdas.ts`) so this module stays free of derivation and env.
 *
 * `TransactionInstruction.data` is typed `Buffer` in web3.js v1, and web3.js calls `Buffer.from`
 * internally, so this module is for server/local use (the /api/issue route handler) — not the
 * browser bundle, where Next.js no longer provides a `Buffer` global.
 */

import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  encodeInitializeConfigData,
  encodeInitializeProfileData,
  encodeIssueCredentialData,
  type Result,
} from "./codecs";

const NON_SIGNER_READONLY = { isSigner: false, isWritable: false } as const;

/** Instruction data must be a Buffer for web3.js v1's `TransactionInstruction`. */
function instructionData(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes);
}

export type InitializeProfileInput = {
  user: PublicKey;
  profilePda: PublicKey;
  programId: PublicKey;
};

export function initializeProfileInstruction(input: InitializeProfileInput): TransactionInstruction {
  return new TransactionInstruction({
    programId: input.programId,
    keys: [
      { pubkey: input.user, isSigner: true, isWritable: true },
      { pubkey: input.profilePda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, ...NON_SIGNER_READONLY },
    ],
    data: instructionData(encodeInitializeProfileData()),
  });
}

export type IssueCredentialInput = {
  user: PublicKey;
  issuer: PublicKey;
  configPda: PublicKey;
  profilePda: PublicKey;
  credentialPda: PublicKey;
  challengeId: number;
  score: number;
  evidenceHash: Uint8Array;
  programId: PublicKey;
};

export function issueCredentialInstruction(input: IssueCredentialInput): Result<TransactionInstruction> {
  const encoded = encodeIssueCredentialData({
    challengeId: input.challengeId,
    score: input.score,
    evidenceHash: input.evidenceHash,
  });
  if (!encoded.ok) {
    return encoded;
  }
  return {
    ok: true,
    data: new TransactionInstruction({
      programId: input.programId,
      keys: [
        { pubkey: input.user, isSigner: true, isWritable: true },
        { pubkey: input.issuer, isSigner: true, isWritable: false },
        { pubkey: input.configPda, ...NON_SIGNER_READONLY },
        { pubkey: input.profilePda, isSigner: false, isWritable: true },
        { pubkey: input.credentialPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, ...NON_SIGNER_READONLY },
      ],
      data: instructionData(encoded.data),
    }),
  };
}

export type InitializeConfigInput = {
  admin: PublicKey;
  issuer: PublicKey;
  configPda: PublicKey;
  /** The program account itself — Anchor requires it to resolve `programdata_address()`. */
  programId: PublicKey;
  programData: PublicKey;
};

/** Deploy-time only: `admin` must be the program's upgrade authority. Used by `scripts/init-config.ts`. */
export function initializeConfigInstruction(input: InitializeConfigInput): TransactionInstruction {
  return new TransactionInstruction({
    programId: input.programId,
    keys: [
      { pubkey: input.admin, isSigner: true, isWritable: true },
      { pubkey: input.configPda, isSigner: false, isWritable: true },
      { pubkey: input.programId, ...NON_SIGNER_READONLY },
      { pubkey: input.programData, ...NON_SIGNER_READONLY },
      { pubkey: SystemProgram.programId, ...NON_SIGNER_READONLY },
    ],
    data: instructionData(encodeInitializeConfigData(input.issuer)),
  });
}
