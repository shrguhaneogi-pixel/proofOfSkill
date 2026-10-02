import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";

import { DEFAULT_PROGRAM_ID } from "./constants";
import { configPda, credentialPda, getProgramId, profilePda, programDataAddress } from "./pdas";

/**
 * Vectors supplied by the lead engineer on 2026-10-02 and re-derived independently in this
 * session with @solana/web3.js 1.99.0. They correspond to the program's own seeds, so
 * `tests/proof_of_skill.ts` can assert the same addresses for the onchain accounts.
 */
const PROGRAM_ID = new PublicKey(DEFAULT_PROGRAM_ID);
const USER = "Fj4v7qWW7k4sTieBCgjNwQUTMC6yVbfHrSwHhR8tw92j";

type Vector = { address: string; bump: number };

const CONFIG_VECTOR: Vector = { address: "Amw2c7oVJNxtbKpWoetmghSqL8VY5Le1wBj9UbFL1TY4", bump: 255 };
const PROFILE_VECTOR: Vector = { address: "A94CxDeVUUi7VPGTg8175hYogkma2eRoiWQ1C41hE5Xw", bump: 255 };

const CREDENTIAL_VECTORS: ReadonlyArray<Vector & { challengeId: 1 | 2 | 3 | 4 | 5 }> = [
  { challengeId: 1, address: "4JzYzqr1CMNmntfSpatBngb9uHGYQqoJfyXkyn6rARKW", bump: 255 },
  { challengeId: 2, address: "575ztNWrf36zKK2qb2FkwCYgf8QNNPWwtP3AdxyPoLe5", bump: 255 },
  { challengeId: 3, address: "BPDd5n2BcgKfhgFyUisdRFxQR6PtjELavQfzs9LUUEHs", bump: 249 },
  { challengeId: 4, address: "6BUcDQaTADfXjVVPEXyd5Q3a5dkVykRwMfHZF7dM5z2G", bump: 254 },
  { challengeId: 5, address: "5Tj8zs2NjYH3k99FemR1ehu4NreneizumE1zKytEvqt4", bump: 254 },
];

function expectVector(actual: { pda: PublicKey; bump: number }, vector: Vector): void {
  expect(actual.pda.toBase58()).toBe(vector.address);
  expect(actual.bump).toBe(vector.bump);
}

describe("configPda", () => {
  it("matches the pinned vector for seeds [config]", () => {
    expectVector(configPda(PROGRAM_ID), CONFIG_VECTOR);
  });

  it("is a distinct address from the per-user PDAs", () => {
    const config = configPda(PROGRAM_ID).pda.toBase58();
    expect(config).not.toBe(profilePda(USER, PROGRAM_ID).pda.toBase58());
    expect(config).not.toBe(credentialPda(USER, 1, PROGRAM_ID).pda.toBase58());
  });
});

describe("profilePda", () => {
  it("matches the pinned vector for seeds [profile, user]", () => {
    expectVector(profilePda(USER, PROGRAM_ID), PROFILE_VECTOR);
  });

  it("accepts a PublicKey as well as a base58 string", () => {
    const fromKey = profilePda(new PublicKey(USER), PROGRAM_ID);
    expect(fromKey.pda.toBase58()).toBe(profilePda(USER, PROGRAM_ID).pda.toBase58());
  });

  it("derives a different address per user", () => {
    const other = PublicKey.default.toBase58();
    expect(profilePda(other, PROGRAM_ID).pda.toBase58()).not.toBe(PROFILE_VECTOR.address);
  });
});

describe("credentialPda", () => {
  it.each(CREDENTIAL_VECTORS)("matches the pinned vector for challenge $challengeId", (vector) => {
    expectVector(credentialPda(USER, vector.challengeId, PROGRAM_ID), vector);
  });

  it("rejects a challenge id outside the onchain range", () => {
    expect(() => credentialPda(USER, 6 as 1, PROGRAM_ID)).toThrow(/outside the onchain range/);
    expect(() => credentialPda(USER, 0 as 1, PROGRAM_ID)).toThrow(/outside the onchain range/);
  });
});

describe("programDataAddress", () => {
  it("is a valid off-curve address derived from the program id", () => {
    const address = programDataAddress(PROGRAM_ID);
    expect(address.toBytes().length).toBe(32);
    expect(PublicKey.isOnCurve(address.toBytes())).toBe(false);
    expect(address.equals(PROGRAM_ID)).toBe(false);
  });

  it("is deterministic", () => {
    expect(programDataAddress(PROGRAM_ID).toBase58()).toBe(programDataAddress(PROGRAM_ID).toBase58());
  });
});

describe("getProgramId", () => {
  it("falls back to the repo program id when the env var is unset", () => {
    delete process.env.NEXT_PUBLIC_PROGRAM_ID;
    expect(getProgramId().toBase58()).toBe(DEFAULT_PROGRAM_ID);
  });

  it("refuses a configured value that is not an address", () => {
    process.env.NEXT_PUBLIC_PROGRAM_ID = "definitely-not-an-address";
    expect(() => getProgramId()).toThrow(/NEXT_PUBLIC_PROGRAM_ID is not a valid Solana address/);
    delete process.env.NEXT_PUBLIC_PROGRAM_ID;
  });

  it("uses an explicitly configured program id", () => {
    process.env.NEXT_PUBLIC_PROGRAM_ID = PublicKey.default.toBase58();
    expect(getProgramId().toBase58()).toBe(PublicKey.default.toBase58());
    delete process.env.NEXT_PUBLIC_PROGRAM_ID;
    expect(getProgramId().toBase58()).toBe(DEFAULT_PROGRAM_ID);
  });
});
