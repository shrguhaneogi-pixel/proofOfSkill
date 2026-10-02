import { Connection, PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

import { hexToBytes } from "../hashing/evidence-hash";
import {
  ACCOUNT_DISCRIMINATORS,
  CREDENTIAL_ACCOUNT_SIZE,
  DEFAULT_PROGRAM_ID,
  USER_PROFILE_ACCOUNT_SIZE,
} from "./constants";
import {
  fetchConfigAccount,
  fetchCredentialAccount,
  fetchProfileAccount,
  fetchWalletCredentials,
  fetchWalletSnapshot,
} from "./queries";

const PROGRAM_ID = new PublicKey(DEFAULT_PROGRAM_ID);
const USER = new PublicKey("Fj4v7qWW7k4sTieBCgjNwQUTMC6yVbfHrSwHhR8tw92j");
const ISSUER = new PublicKey("Amw2c7oVJNxtbKpWoetmghSqL8VY5Le1wBj9UbFL1TY4");
const CREDENTIAL_PDA = new PublicKey("4JzYzqr1CMNmntfSpatBngb9uHGYQqoJfyXkyn6rARKW");
const EVIDENCE_HASH = hexToBytes("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");

function accountInfo(data: Uint8Array, owner: PublicKey = PROGRAM_ID) {
  return {
    executable: false,
    owner,
    lamports: 1_000_000,
    data: Buffer.from(data),
    rentEpoch: 0,
  };
}

function credentialData(challengeId: number): Uint8Array {
  const bytes = new Uint8Array(CREDENTIAL_ACCOUNT_SIZE);
  const view = new DataView(bytes.buffer);
  bytes.set(ACCOUNT_DISCRIMINATORS.credential, 0);
  bytes.set(USER.toBytes(), 8);
  bytes.set(ISSUER.toBytes(), 40);
  bytes.set(EVIDENCE_HASH, 72);
  view.setBigInt64(104, BigInt("9223372036854775807"), true);
  view.setUint8(112, challengeId);
  view.setUint8(113, 92);
  view.setUint8(114, 255);
  return bytes;
}

function profileData(): Uint8Array {
  const bytes = new Uint8Array(USER_PROFILE_ACCOUNT_SIZE);
  const view = new DataView(bytes.buffer);
  bytes.set(ACCOUNT_DISCRIMINATORS.userProfile, 0);
  bytes.set(USER.toBytes(), 8);
  view.setBigInt64(40, BigInt("1759400000"), true);
  view.setUint32(48, 2, true);
  view.setUint32(52, 184, true);
  bytes[56] = 255;
  return bytes;
}

function stubConnection(): Connection {
  // A real Connection is never used for I/O here: every RPC method below is replaced.
  return new Connection("http://127.0.0.1:1", "confirmed");
}

describe("fetchProfileAccount", () => {
  it("decodes the account owned by the program", async () => {
    const connection = stubConnection();
    const spy = vi.spyOn(connection, "getAccountInfo").mockResolvedValue(accountInfo(profileData()));

    const result = await fetchProfileAccount(connection, USER);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data?.user.toBase58()).toBe(USER.toBase58());
    expect(result.data?.completedCount).toBe(2);
    expect(result.data?.reputation).toBe(184);
    expect(result.data?.createdAt).toBe(BigInt("1759400000"));
    const calledAddress = spy.mock.calls[0]?.[0];
    expect(calledAddress?.toBase58()).toBe("A94CxDeVUUi7VPGTg8175hYogkma2eRoiWQ1C41hE5Xw");
  });

  it("reports a missing account as null rather than an error", async () => {
    const connection = stubConnection();
    vi.spyOn(connection, "getAccountInfo").mockResolvedValue(null);

    const result = await fetchProfileAccount(connection, USER);
    expect(result).toEqual({ ok: true, data: null });
  });

  it("surfaces an RPC failure as an error result", async () => {
    const connection = stubConnection();
    vi.spyOn(connection, "getAccountInfo").mockRejectedValue(new Error("fetch failed"));

    const result = await fetchProfileAccount(connection, USER);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("fetch failed");
  });

  it("refuses an account owned by another program", async () => {
    const connection = stubConnection();
    vi.spyOn(connection, "getAccountInfo").mockResolvedValue(
      accountInfo(profileData(), new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")),
    );

    const result = await fetchProfileAccount(connection, USER);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("not the proof_of_skill program");
  });
});

describe("fetchConfigAccount", () => {
  it("decodes Config from the config PDA", async () => {
    const connection = stubConnection();
    const config = new Uint8Array(73);
    config.set(ACCOUNT_DISCRIMINATORS.config, 0);
    config.set(USER.toBytes(), 8);
    config.set(ISSUER.toBytes(), 40);
    config[72] = 255;
    vi.spyOn(connection, "getAccountInfo").mockResolvedValue(accountInfo(config));

    const result = await fetchConfigAccount(connection);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data?.admin.toBase58()).toBe(USER.toBase58());
      expect(result.data?.issuer.toBase58()).toBe(ISSUER.toBase58());
    }
  });
});

describe("fetchCredentialAccount", () => {
  it("decodes a credential by PDA, as the verify page does", async () => {
    const connection = stubConnection();
    vi.spyOn(connection, "getAccountInfo").mockResolvedValue(accountInfo(credentialData(1)));

    const result = await fetchCredentialAccount(connection, CREDENTIAL_PDA);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data?.challengeId).toBe(1);
      expect(result.data?.score).toBe(92);
      expect(result.data?.issuedAt).toBe(BigInt("9223372036854775807"));
    }
  });

  it("rejects a credential sized account whose discriminator is wrong", async () => {
    const connection = stubConnection();
    const junk = credentialData(1);
    junk[0] = 0;
    vi.spyOn(connection, "getAccountInfo").mockResolvedValue(accountInfo(junk));

    const result = await fetchCredentialAccount(connection, CREDENTIAL_PDA);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("discriminator mismatch");
  });
});

describe("fetchWalletCredentials", () => {
  it("queries with memcmp offset 8 plus a dataSize filter, exactly as documented", async () => {
    const connection = stubConnection();
    const spy = vi.spyOn(connection, "getProgramAccounts").mockResolvedValue([
      { pubkey: CREDENTIAL_PDA, account: accountInfo(credentialData(1)) },
      { pubkey: new PublicKey("575ztNWrf36zKK2qb2FkwCYgf8QNNPWwtP3AdxyPoLe5"), account: accountInfo(credentialData(2)) },
    ]);

    const result = await fetchWalletCredentials(connection, USER);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.map((record) => record.account.challengeId)).toEqual([1, 2]);
      expect(result.data[0].address.toBase58()).toBe(CREDENTIAL_PDA.toBase58());
    }
    const call = spy.mock.calls[0];
    expect(call?.[0].toBase58()).toBe(DEFAULT_PROGRAM_ID);
    expect(call?.[1]).toEqual({
      filters: [
        { memcmp: { offset: 8, bytes: USER.toBase58() } },
        { dataSize: CREDENTIAL_ACCOUNT_SIZE },
      ],
    });
  });

  it("fails loudly when a returned account does not decode", async () => {
    const connection = stubConnection();
    const broken = credentialData(3);
    broken[113] = 250;
    vi.spyOn(connection, "getProgramAccounts").mockResolvedValue([
      { pubkey: CREDENTIAL_PDA, account: accountInfo(broken) },
    ]);

    const result = await fetchWalletCredentials(connection, USER);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain(CREDENTIAL_PDA.toBase58());
  });

  it("surfaces an RPC failure", async () => {
    const connection = stubConnection();
    vi.spyOn(connection, "getProgramAccounts").mockRejectedValue(new Error("429 too many requests"));

    const result = await fetchWalletCredentials(connection, USER);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("429 too many requests");
  });
});

describe("fetchWalletSnapshot", () => {
  it("combines the profile and the credential list", async () => {
    const connection = stubConnection();
    vi.spyOn(connection, "getAccountInfo").mockResolvedValue(accountInfo(profileData()));
    vi.spyOn(connection, "getProgramAccounts").mockResolvedValue([
      { pubkey: CREDENTIAL_PDA, account: accountInfo(credentialData(1)) },
    ]);

    const result = await fetchWalletSnapshot(connection, USER);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.profile?.completedCount).toBe(2);
      expect(result.data.credentials).toHaveLength(1);
    }
  });

  it("propagates the first failure", async () => {
    const connection = stubConnection();
    vi.spyOn(connection, "getAccountInfo").mockRejectedValue(new Error("profile down"));
    vi.spyOn(connection, "getProgramAccounts").mockResolvedValue([]);

    const result = await fetchWalletSnapshot(connection, USER);
    expect(result.ok).toBe(false);
  });
});
