import { PublicKey, SystemProgram } from "@solana/web3.js";
import { bytesToHex } from "../hashing/evidence-hash";
import { describe, expect, it } from "vitest";

import { INSTRUCTION_DISCRIMINATOR_HEX } from "./constants";
import {
  initializeConfigInstruction,
  initializeProfileInstruction,
  issueCredentialInstruction,
} from "./program";

const PROGRAM_ID = new PublicKey("5BLtjKxvax6xxVp6xF3wgmaV3NbmXwbdGsM1sytsqji3");
const USER = new PublicKey("Fj4v7qWW7k4sTieBCgjNwQUTMC6yVbfHrSwHhR8tw92j");
const ISSUER = new PublicKey("Amw2c7oVJNxtbKpWoetmghSqL8VY5Le1wBj9UbFL1TY4");
const CONFIG_PDA = new PublicKey("Amw2c7oVJNxtbKpWoetmghSqL8VY5Le1wBj9UbFL1TY4");
const PROFILE_PDA = new PublicKey("A94CxDeVUUi7VPGTg8175hYogkma2eRoiWQ1C41hE5Xw");
const CREDENTIAL_PDA = new PublicKey("4JzYzqr1CMNmntfSpatBngb9uHGYQqoJfyXkyn6rARKW");
const PROGRAM_DATA = new PublicKey("6BUcDQaTADfXjVVPEXyd5Q3a5dkVykRwMfHZF7dM5z2G");
const EVIDENCE_HASH = new Uint8Array(32).fill(7);

function meta(instruction: { keys: ReadonlyArray<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }> }) {
  return instruction.keys.map((key) => ({
    pubkey: key.pubkey.toBase58(),
    isSigner: key.isSigner,
    isWritable: key.isWritable,
  }));
}

describe("initializeProfileInstruction", () => {
  it("matches the InitializeProfile accounts struct order", () => {
    const instruction = initializeProfileInstruction({
      user: USER,
      profilePda: PROFILE_PDA,
      programId: PROGRAM_ID,
    });

    expect(meta(instruction)).toEqual([
      { pubkey: USER.toBase58(), isSigner: true, isWritable: true },
      { pubkey: PROFILE_PDA.toBase58(), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId.toBase58(), isSigner: false, isWritable: false },
    ]);
    expect(instruction.programId.equals(PROGRAM_ID)).toBe(true);
    expect(bytesToHex(new Uint8Array(instruction.data))).toBe(INSTRUCTION_DISCRIMINATOR_HEX.initializeProfile);
    expect(instruction.data.length).toBe(8);
  });
});

describe("issueCredentialInstruction", () => {
  const input = {
    user: USER,
    issuer: ISSUER,
    configPda: CONFIG_PDA,
    profilePda: PROFILE_PDA,
    credentialPda: CREDENTIAL_PDA,
    challengeId: 1,
    score: 88,
    evidenceHash: EVIDENCE_HASH,
    programId: PROGRAM_ID,
  };

  it("matches the IssueCredential accounts struct order", () => {
    const result = issueCredentialInstruction(input);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(meta(result.data)).toEqual([
      { pubkey: USER.toBase58(), isSigner: true, isWritable: true },
      { pubkey: ISSUER.toBase58(), isSigner: true, isWritable: false },
      { pubkey: CONFIG_PDA.toBase58(), isSigner: false, isWritable: false },
      { pubkey: PROFILE_PDA.toBase58(), isSigner: false, isWritable: true },
      { pubkey: CREDENTIAL_PDA.toBase58(), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId.toBase58(), isSigner: false, isWritable: false },
    ]);
  });

  it("encodes discriminator, challenge id, score and evidence hash", () => {
    const result = issueCredentialInstruction(input);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(bytesToHex(new Uint8Array(result.data.data))).toBe(
      `${INSTRUCTION_DISCRIMINATOR_HEX.issueCredential}0158${"07".repeat(32)}`,
    );
  });

  it("propagates the codec rejection instead of building a doomed instruction", () => {
    const result = issueCredentialInstruction({ ...input, score: 42 });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("below the passing threshold");
  });
});

describe("initializeConfigInstruction", () => {
  it("matches the InitializeConfig accounts struct order and arg layout", () => {
    const instruction = initializeConfigInstruction({
      admin: USER,
      issuer: ISSUER,
      configPda: CONFIG_PDA,
      programId: PROGRAM_ID,
      programData: PROGRAM_DATA,
    });

    expect(meta(instruction)).toEqual([
      { pubkey: USER.toBase58(), isSigner: true, isWritable: true },
      { pubkey: CONFIG_PDA.toBase58(), isSigner: false, isWritable: true },
      { pubkey: PROGRAM_ID.toBase58(), isSigner: false, isWritable: false },
      { pubkey: PROGRAM_DATA.toBase58(), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId.toBase58(), isSigner: false, isWritable: false },
    ]);
    expect(bytesToHex(new Uint8Array(instruction.data))).toBe(
      `${INSTRUCTION_DISCRIMINATOR_HEX.initializeConfig}${bytesToHex(ISSUER.toBytes())}`,
    );
  });
});
