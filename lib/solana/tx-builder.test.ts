import { Keypair, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { bytesToHex, hexToBytes } from "../hashing/evidence-hash";
import { describe, expect, it, vi } from "vitest";

// `server-only` throws when imported outside a React server graph; vitest hoists this above the
// import of ./tx-builder.server, so the module under test still loads.
vi.mock("server-only", () => ({ default: {} }));

import { DEFAULT_PROGRAM_ID, INSTRUCTION_DISCRIMINATORS } from "./constants";
import { configPda, credentialPda, profilePda } from "./pdas";
import { compileIssueTransaction, keypairFromSecretKey } from "./tx-builder.server";

const WALLET = new PublicKey("Fj4v7qWW7k4sTieBCgjNwQUTMC6yVbfHrSwHhR8tw92j");
/** Any valid 32 byte base58 value compiles; only the chain validates the blockhash itself. */
const BLOCKHASH = "11111111111111111111111111111111";
const EVIDENCE_HASH = hexToBytes("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");

const issuer = Keypair.generate();

function request(overrides: Partial<Parameters<typeof compileIssueTransaction>[0]> = {}) {
  return {
    wallet: WALLET.toBase58(),
    issuer,
    challengeId: 1,
    score: 88,
    evidenceHash: EVIDENCE_HASH,
    blockhash: BLOCKHASH,
    lastValidBlockHeight: 1234,
    profileExists: false,
    ...overrides,
  };
}

function decodeBase64Transaction(base64: string): VersionedTransaction {
  return VersionedTransaction.deserialize(new Uint8Array(Buffer.from(base64, "base64")));
}

describe("compileIssueTransaction", () => {
  it("returns exactly the POST /api/issue body", () => {
    const result = compileIssueTransaction(request());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(Object.keys(result.data).sort()).toEqual([
      "blockhash",
      "credentialPda",
      "lastValidBlockHeight",
      "profilePda",
      "transaction",
    ]);
    expect(result.data.blockhash).toBe(BLOCKHASH);
    expect(result.data.lastValidBlockHeight).toBe(1234);
    expect(result.data.profilePda).toBe(profilePda(WALLET).pda.toBase58());
    expect(result.data.credentialPda).toBe(credentialPda(WALLET, 1).pda.toBase58());
    expect(result.data.transaction.length).toBeGreaterThan(0);
  });

  it("prepends initialize_profile only when the profile is absent", () => {
    const withoutProfile = compileIssueTransaction(request({ profileExists: false }));
    const withProfile = compileIssueTransaction(request({ profileExists: true }));
    expect(withoutProfile.ok && withProfile.ok).toBe(true);
    if (!withoutProfile.ok || !withProfile.ok) {
      return;
    }
    expect(
      TransactionMessage.decompile(decodeBase64Transaction(withoutProfile.data.transaction).message)
        .instructions,
    ).toHaveLength(2);
    expect(
      TransactionMessage.decompile(decodeBase64Transaction(withProfile.data.transaction).message).instructions,
    ).toHaveLength(1);
  });

  it("carries both instruction discriminators and the credential args", () => {
    const result = compileIssueTransaction(request({ challengeId: 3, score: 70 }));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const instructions = TransactionMessage.decompile(
      decodeBase64Transaction(result.data.transaction).message,
    ).instructions;
    expect(bytesToHex(new Uint8Array(instructions[0].data))).toBe(
      bytesToHex(INSTRUCTION_DISCRIMINATORS.initializeProfile),
    );
    // 0x03 = challenge id 3, 0x46 = score 70.
    expect(bytesToHex(new Uint8Array(instructions[1].data))).toBe(
      `${bytesToHex(INSTRUCTION_DISCRIMINATORS.issueCredential)}0346${bytesToHex(EVIDENCE_HASH)}`,
    );
  });

  it("is a v0 message whose fee payer is the wallet and whose issuer slot is signed", () => {
    const result = compileIssueTransaction(request());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const transaction = decodeBase64Transaction(result.data.transaction);
    expect(transaction.version).toBe(0);
    expect(transaction.message.staticAccountKeys[0]?.toBase58()).toBe(WALLET.toBase58());
    expect(transaction.message.header.numRequiredSignatures).toBe(2);

    const walletSignature = transaction.signatures[0];
    const issuerSignature = transaction.signatures[1];
    expect(Array.from(walletSignature)).toEqual(new Array(64).fill(0));
    expect(issuerSignature.length).toBe(64);
    expect(Array.from(issuerSignature).some((byte) => byte !== 0)).toBe(true);
  });

  it("references the config, profile and credential PDAs of the pinned program", () => {
    const result = compileIssueTransaction(request());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const transaction = decodeBase64Transaction(result.data.transaction);
    const issue = TransactionMessage.decompile(transaction.message).instructions[1];
    const keys = issue.keys.map((key) => key.pubkey.toBase58());

    expect(keys).toContain(configPda(new PublicKey(DEFAULT_PROGRAM_ID)).pda.toBase58());
    expect(keys).toContain(profilePda(WALLET).pda.toBase58());
    expect(keys).toContain(credentialPda(WALLET, 1).pda.toBase58());
    expect(keys).toContain(issuer.publicKey.toBase58());
    expect(issue.programId.toBase58()).toBe(DEFAULT_PROGRAM_ID);
  });

  const failures: ReadonlyArray<[string, Partial<Parameters<typeof compileIssueTransaction>[0]>, string]> = [
    ["a malformed wallet", { wallet: "not-base58-0OlI" }, "INVALID_WALLET"],
    ["an out of range challenge", { challengeId: 6 }, "INVALID_ISSUE_ARGS"],
    ["a failing score", { score: 55 }, "INVALID_ISSUE_ARGS"],
    ["an empty evidence hash", { evidenceHash: new Uint8Array(32) }, "INVALID_ISSUE_ARGS"],
    ["a junk blockhash", { blockhash: "nope!" }, "INVALID_BLOCKHASH"],
    ["a short blockhash", { blockhash: "11111" }, "INVALID_BLOCKHASH"],
  ];

  it.each(failures)("refuses %s", (_label, overrides, code) => {
    const result = compileIssueTransaction(request(overrides));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe(code);
    expect(result.message.length).toBeGreaterThan(0);
  });
});

describe("keypairFromSecretKey", () => {
  it("rebuilds the same keypair from its 64 byte secret key", () => {
    const generated = Keypair.generate();
    const result = keypairFromSecretKey(generated.secretKey);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.publicKey.toBase58()).toBe(generated.publicKey.toBase58());
      expect(result.data.secretKey).toEqual(generated.secretKey);
    }
  });

  it("accepts a plain number array, as stored in ISSUER_PRIVATE_KEY", () => {
    const generated = Keypair.generate();
    const result = keypairFromSecretKey(Array.from(generated.secretKey));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.publicKey.toBase58()).toBe(generated.publicKey.toBase58());
    }
  });

  it("refuses a truncated or mismatched key", () => {
    expect(keypairFromSecretKey(new Uint8Array(63)).ok).toBe(false);
    const tampered = Array.from(Keypair.generate().secretKey);
    tampered[40] = (tampered[40] ?? 0) + 1;
    const result = keypairFromSecretKey(tampered);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.code).toBe("INVALID_ISSUE_ARGS");
  });
});
