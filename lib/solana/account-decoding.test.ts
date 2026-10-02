import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { bytesToHex, hexToBytes } from "../hashing/evidence-hash";
import {
  ACCOUNT_DISCRIMINATOR_HEX,
  ACCOUNT_DISCRIMINATORS,
  CONFIG_ACCOUNT_SIZE,
  CREDENTIAL_ACCOUNT_SIZE,
  DISCRIMINATOR_LENGTH,
  PUBLIC_KEY_LENGTH,
  USER_PROFILE_ACCOUNT_SIZE,
} from "./constants";
import {
  decodeConfigAccount,
  decodeCredentialAccount,
  decodeUserProfileAccount,
} from "./codecs";

const USER = new PublicKey("Fj4v7qWW7k4sTieBCgjNwQUTMC6yVbfHrSwHhR8tw92j");
const ISSUER = new PublicKey("5BLtjKxvax6xxVp6xF3wgmaV3NbmXwbdGsM1sytsqji3");
const EVIDENCE_HASH = hexToBytes("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");

/** Builds the exact onchain layout: discriminator then borsh fields, little-endian. */
function configBuffer(
  admin: PublicKey,
  issuer: PublicKey,
  bump: number,
  overrides: { discriminator?: Uint8Array; size?: number } = {},
): Uint8Array {
  const bytes = new Uint8Array(overrides.size ?? CONFIG_ACCOUNT_SIZE);
  bytes.set(overrides.discriminator ?? ACCOUNT_DISCRIMINATORS.config, 0);
  bytes.set(admin.toBytes(), DISCRIMINATOR_LENGTH);
  bytes.set(issuer.toBytes(), DISCRIMINATOR_LENGTH + PUBLIC_KEY_LENGTH);
  bytes[CONFIG_ACCOUNT_SIZE - 1] = bump;
  return bytes;
}

function profileBuffer(
  user: PublicKey,
  createdAt: bigint,
  completedCount: number,
  reputation: number,
  bump: number,
): Uint8Array {
  const bytes = new Uint8Array(USER_PROFILE_ACCOUNT_SIZE);
  const view = new DataView(bytes.buffer);
  bytes.set(ACCOUNT_DISCRIMINATORS.userProfile, 0);
  bytes.set(user.toBytes(), DISCRIMINATOR_LENGTH);
  view.setBigInt64(DISCRIMINATOR_LENGTH + PUBLIC_KEY_LENGTH, createdAt, true);
  view.setUint32(DISCRIMINATOR_LENGTH + PUBLIC_KEY_LENGTH + 8, completedCount, true);
  view.setUint32(DISCRIMINATOR_LENGTH + PUBLIC_KEY_LENGTH + 12, reputation, true);
  bytes[USER_PROFILE_ACCOUNT_SIZE - 1] = bump;
  return bytes;
}

type CredentialFields = {
  user: PublicKey;
  issuer: PublicKey;
  evidenceHash: Uint8Array;
  issuedAt: bigint;
  challengeId: number;
  score: number;
  bump: number;
  discriminator?: Uint8Array;
};

function credentialBuffer(fields: CredentialFields): Uint8Array {
  const bytes = new Uint8Array(CREDENTIAL_ACCOUNT_SIZE);
  const view = new DataView(bytes.buffer);
  bytes.set(fields.discriminator ?? ACCOUNT_DISCRIMINATORS.credential, 0);
  let offset = DISCRIMINATOR_LENGTH;
  bytes.set(fields.user.toBytes(), offset);
  offset += PUBLIC_KEY_LENGTH;
  bytes.set(fields.issuer.toBytes(), offset);
  offset += PUBLIC_KEY_LENGTH;
  bytes.set(fields.evidenceHash, offset);
  offset += PUBLIC_KEY_LENGTH;
  view.setBigInt64(offset, fields.issuedAt, true);
  offset += 8;
  view.setUint8(offset, fields.challengeId);
  view.setUint8(offset + 1, fields.score);
  view.setUint8(offset + 2, fields.bump);
  return bytes;
}

/** Maximum score, and an `issued_at` that needs 40 bits, so a 32 bit read cannot pass. */
const KNOWN_CREDENTIAL: CredentialFields = {
  user: USER,
  issuer: ISSUER,
  evidenceHash: EVIDENCE_HASH,
  issuedAt: BigInt("1000000000000"),
  challengeId: 5,
  score: 100,
  bump: 249,
};

describe("decodeConfigAccount", () => {
  it("round-trips every field", () => {
    const decoded = decodeConfigAccount(configBuffer(ISSUER, USER, 255));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) {
      return;
    }
    expect(decoded.data.admin.toBase58()).toBe(ISSUER.toBase58());
    expect(decoded.data.issuer.toBase58()).toBe(USER.toBase58());
    expect(decoded.data.bump).toBe(255);
  });

  it("refuses the wrong length", () => {
    const decoded = decodeConfigAccount(configBuffer(ISSUER, USER, 255, { size: CONFIG_ACCOUNT_SIZE + 1 }));
    expect(decoded.ok).toBe(false);
    if (decoded.ok) {
      return;
    }
    expect(decoded.error).toContain(`must be ${CONFIG_ACCOUNT_SIZE} bytes`);
  });

  it("refuses another account's discriminator", () => {
    const decoded = decodeConfigAccount(
      configBuffer(ISSUER, USER, 255, { discriminator: ACCOUNT_DISCRIMINATORS.credential }),
    );
    expect(decoded.ok).toBe(false);
    if (decoded.ok) {
      return;
    }
    expect(decoded.error).toContain("discriminator mismatch");
    expect(decoded.error).toContain(ACCOUNT_DISCRIMINATOR_HEX.config);
  });
});

describe("decodeUserProfileAccount", () => {
  it("round-trips every field, including i64 and u32 bounds", () => {
    const createdAt = BigInt("-1");
    const decoded = decodeUserProfileAccount(profileBuffer(USER, createdAt, 4294967295, 5, 255));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) {
      return;
    }
    expect(decoded.data.user.toBase58()).toBe(USER.toBase58());
    expect(decoded.data.createdAt).toBe(createdAt);
    expect(decoded.data.completedCount).toBe(4294967295);
    expect(decoded.data.reputation).toBe(5);
    expect(decoded.data.bump).toBe(255);
  });

  it("reads a large positive i64", () => {
    const createdAt = BigInt("9223372036854775807");
    const decoded = decodeUserProfileAccount(profileBuffer(USER, createdAt, 0, 0, 255));
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.data.createdAt).toBe(createdAt);
    }
  });

  it("refuses data of the wrong length, whatever the discriminator says", () => {
    expect(decodeUserProfileAccount(profileBuffer(USER, BigInt(0), 0, 0, 255).subarray(0, 56)).ok).toBe(false);
    const asCredential = decodeUserProfileAccount(
      credentialBuffer({ ...KNOWN_CREDENTIAL, discriminator: ACCOUNT_DISCRIMINATORS.userProfile }),
    );
    expect(asCredential.ok).toBe(false);
    if (asCredential.ok) {
      return;
    }
    expect(asCredential.error).toContain(`${USER_PROFILE_ACCOUNT_SIZE} bytes`);
  });
});

describe("decodeCredentialAccount", () => {
  it("round-trips every field", () => {
    const decoded = decodeCredentialAccount(credentialBuffer(KNOWN_CREDENTIAL));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) {
      return;
    }
    expect(decoded.data.user.toBase58()).toBe(USER.toBase58());
    expect(decoded.data.issuer.toBase58()).toBe(ISSUER.toBase58());
    expect(bytesToHex(decoded.data.evidenceHash)).toBe(bytesToHex(EVIDENCE_HASH));
    expect(decoded.data.issuedAt).toBe(KNOWN_CREDENTIAL.issuedAt);
    expect(decoded.data.challengeId).toBe(5);
    expect(decoded.data.score).toBe(100);
    expect(decoded.data.bump).toBe(249);
  });

  it("does not alias the decoded evidence hash to the source buffer", () => {
    const source = credentialBuffer(KNOWN_CREDENTIAL);
    const decoded = decodeCredentialAccount(source);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) {
      return;
    }
    decoded.data.evidenceHash[0] = 0;
    expect(source[DISCRIMINATOR_LENGTH + PUBLIC_KEY_LENGTH * 2]).not.toBe(0);
  });

  it("reads the right bytes from a Buffer view, as RPC data arrives", () => {
    const padded = Buffer.concat([Buffer.from([9, 9, 9, 9]), credentialBuffer(KNOWN_CREDENTIAL)]);
    const decoded = decodeCredentialAccount(padded.subarray(4));
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(bytesToHex(decoded.data.evidenceHash)).toBe(bytesToHex(EVIDENCE_HASH));
    }
  });

  it("fails on a discriminator that belongs to another account", () => {
    const decoded = decodeCredentialAccount(
      credentialBuffer({ ...KNOWN_CREDENTIAL, discriminator: ACCOUNT_DISCRIMINATORS.config }),
    );
    expect(decoded.ok).toBe(false);
    if (decoded.ok) {
      return;
    }
    expect(decoded.error).toContain("discriminator mismatch");
    expect(decoded.error).toContain(ACCOUNT_DISCRIMINATOR_HEX.credential);
  });

  it("fails on both short and long data", () => {
    const full = credentialBuffer(KNOWN_CREDENTIAL);
    expect(decodeCredentialAccount(full.subarray(0, CREDENTIAL_ACCOUNT_SIZE - 1)).ok).toBe(false);

    const long = new Uint8Array(CREDENTIAL_ACCOUNT_SIZE + 1);
    long.set(full, 0);
    const decoded = decodeCredentialAccount(long);
    expect(decoded.ok).toBe(false);
    if (decoded.ok) {
      return;
    }
    expect(decoded.error).toContain(`must be ${CREDENTIAL_ACCOUNT_SIZE} bytes`);
  });

  it("refuses values the program cannot write", () => {
    expect(decodeCredentialAccount(credentialBuffer({ ...KNOWN_CREDENTIAL, challengeId: 0 })).ok).toBe(false);
    expect(decodeCredentialAccount(credentialBuffer({ ...KNOWN_CREDENTIAL, challengeId: 6 })).ok).toBe(false);
    expect(decodeCredentialAccount(credentialBuffer({ ...KNOWN_CREDENTIAL, score: 101 })).ok).toBe(false);
  });
});
