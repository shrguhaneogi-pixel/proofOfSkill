import { createHash } from "node:crypto";

import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { bytesToHex, hexToBytes } from "../hashing/evidence-hash";
import {
  ACCOUNT_DISCRIMINATOR_HEX,
  ACCOUNT_DISCRIMINATORS,
  DISCRIMINATOR_LENGTH,
  INSTRUCTION_DISCRIMINATOR_HEX,
  INSTRUCTION_DISCRIMINATORS,
  PUBLIC_KEY_LENGTH,
  type AccountName,
  type InstructionName,
} from "./constants";
import {
  encodeInitializeConfigData,
  encodeInitializeProfileData,
  encodeIssueCredentialData,
  evidenceHashFromHex,
  parsePublicKey,
  toPublicKey,
  type IssueCredentialArgs,
} from "./codecs";

const USER = new PublicKey("Fj4v7qWW7k4sTieBCgjNwQUTMC6yVbfHrSwHhR8tw92j");
const ISSUER = new PublicKey("5BLtjKxvax6xxVp6xF3wgmaV3NbmXwbdGsM1sytsqji3");
/** SHA-256 of the empty string; asserted below so this literal cannot drift. */
const EVIDENCE_HASH_HEX = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const EVIDENCE_HASH = hexToBytes(EVIDENCE_HASH_HEX);

function anchorDiscriminator(prefix: string, name: string): string {
  return createHash("sha256").update(`${prefix}:${name}`).digest("hex").slice(0, 16);
}

function issueArgs(
  overrides: { challengeId?: number; score?: number; evidenceHash?: Uint8Array },
): IssueCredentialArgs {
  return {
    challengeId: overrides.challengeId ?? 1,
    score: overrides.score ?? 70,
    evidenceHash: overrides.evidenceHash ?? EVIDENCE_HASH,
  };
}

describe("anchor discriminators", () => {
  const instructionPreimages: ReadonlyArray<[InstructionName, string]> = [
    ["initializeConfig", "initialize_config"],
    ["initializeProfile", "initialize_profile"],
    ["issueCredential", "issue_credential"],
  ];
  const accountPreimages: ReadonlyArray<[AccountName, string]> = [
    ["config", "Config"],
    ["userProfile", "UserProfile"],
    ["credential", "Credential"],
  ];

  it.each(instructionPreimages)("global:%s prefix matches the pinned value", (key, snake) => {
    expect(INSTRUCTION_DISCRIMINATOR_HEX[key]).toBe(anchorDiscriminator("global", snake));
    expect(bytesToHex(INSTRUCTION_DISCRIMINATORS[key])).toBe(anchorDiscriminator("global", snake));
  });

  it.each(accountPreimages)("account:%s prefix matches the pinned value", (key, struct) => {
    expect(ACCOUNT_DISCRIMINATOR_HEX[key]).toBe(anchorDiscriminator("account", struct));
    expect(bytesToHex(ACCOUNT_DISCRIMINATORS[key])).toBe(anchorDiscriminator("account", struct));
  });

  it("uses a real sha-256 vector for the evidence hash fixture", () => {
    expect(createHash("sha256").update("").digest("hex")).toBe(EVIDENCE_HASH_HEX);
  });
});

describe("instruction data encoding", () => {
  it("initialize_profile is the discriminator alone", () => {
    const data = encodeInitializeProfileData();
    expect(data.length).toBe(DISCRIMINATOR_LENGTH);
    expect(bytesToHex(data)).toBe("20914dd53a27fbea");
  });

  it("initialize_config is the discriminator plus the raw 32 byte issuer", () => {
    const data = encodeInitializeConfigData(ISSUER);
    expect(data.length).toBe(DISCRIMINATOR_LENGTH + PUBLIC_KEY_LENGTH);
    expect(bytesToHex(data)).toBe(`d07f1501c2bec446${bytesToHex(ISSUER.toBytes())}`);
  });

  it("issue_credential is discriminator + u8 challenge + u8 score + 32 byte hash", () => {
    const result = encodeIssueCredentialData({ challengeId: 3, score: 88, evidenceHash: EVIDENCE_HASH });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.length).toBe(42);
    // 0x03 = challenge id 3, 0x58 = score 88.
    expect(bytesToHex(result.data)).toBe(`ffc1abe044abc2570358${EVIDENCE_HASH_HEX}`);
  });

  const rejected: ReadonlyArray<[string, Partial<{ challengeId: number; score: number; evidenceHash: Uint8Array }>]> = [
    ["challenge id 0", { challengeId: 0 }],
    ["challenge id 6", { challengeId: 6 }],
    ["fractional challenge id", { challengeId: 2.5 }],
    ["score below the threshold", { score: 69 }],
    ["score above 100", { score: 101 }],
    ["fractional score", { score: 88.5 }],
    ["short evidence hash", { evidenceHash: new Uint8Array(31) }],
    ["all zero evidence hash", { evidenceHash: new Uint8Array(32) }],
  ];

  it.each(rejected)("rejects %s", (_label, overrides) => {
    expect(encodeIssueCredentialData(issueArgs(overrides)).ok).toBe(false);
  });

  it("accepts the boundary values the program allows", () => {
    expect(encodeIssueCredentialData(issueArgs({ challengeId: 1, score: 70 })).ok).toBe(true);
    expect(encodeIssueCredentialData(issueArgs({ challengeId: 5, score: 100 })).ok).toBe(true);
  });
});

describe("address and hash parsing", () => {
  it("parses a valid address", () => {
    const parsed = parsePublicKey(USER.toBase58());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.data.toBase58()).toBe(USER.toBase58());
    }
  });

  it("rejects a string with characters outside the base58 alphabet", () => {
    expect(parsePublicKey("0OlI").ok).toBe(false);
  });

  it("rejects a base58 string that is not 32 bytes", () => {
    const parsed = parsePublicKey("1111111111111111111111111111111");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.error).toContain(`${PUBLIC_KEY_LENGTH} bytes`);
  });

  it("toPublicKey passes keys through and throws on junk", () => {
    expect(toPublicKey(USER).equals(USER)).toBe(true);
    expect(toPublicKey(USER.toBase58()).equals(USER)).toBe(true);
    expect(() => toPublicKey("nope!")).toThrow(/invalid Solana address/);
  });

  it("accepts a 64 character evidence hash and refuses anything else", () => {
    const parsed = evidenceHashFromHex(EVIDENCE_HASH_HEX);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(bytesToHex(parsed.data)).toBe(EVIDENCE_HASH_HEX);
    }
    expect(evidenceHashFromHex(EVIDENCE_HASH_HEX.slice(0, 62)).ok).toBe(false);
    expect(evidenceHashFromHex("zz".repeat(32)).ok).toBe(false);
  });
});
