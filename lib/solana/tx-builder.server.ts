/**
 * Server-side composer for the issue transaction (docs/architecture.md → SYSTEM_OVERVIEW step 3).
 *
 * Expected route flow for POST /api/issue:
 *   verify attestation → parse wallet → `fetchCredentialAccount(...)` and answer 409 when it
 *   already exists → `buildIssueTransaction(...)` → return the result data verbatim.
 *
 * The transaction is only *partially* signed here. web3.js v1 `VersionedTransaction.sign()` fills
 * the slots of the signers it is handed and leaves the others zeroed, so passing the issuer alone
 * produces exactly the half-signed transaction the wallet completes in the browser. There is no
 * `VersionedTransaction.partialSign` in @solana/web3.js 1.99.0.
 */

import "server-only";

import {
  Connection,
  Keypair,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import base58 from "bs58";
import { parsePublicKey, type ConfigAccount } from "./codecs";
import { getConnection } from "./connection";
import { PUBLIC_KEY_LENGTH, isChallengeId } from "./constants";
import { configPda, credentialPda, getProgramId, profilePda } from "./pdas";
import { fetchConfigAccount, fetchProfileAccount } from "./queries";
import { initializeProfileInstruction, issueCredentialInstruction } from "./program";

export type IssueErrorCode =
  | "INVALID_WALLET"
  | "INVALID_ISSUE_ARGS"
  | "INVALID_BLOCKHASH"
  | "CONFIG_NOT_INITIALIZED"
  | "ISSUER_MISMATCH"
  | "RPC_ERROR";

export type IssueTransaction = {
  transaction: string;
  blockhash: string;
  lastValidBlockHeight: number;
  credentialPda: string;
  profilePda: string;
};

export type IssueResult<T> = { ok: true; data: T } | { ok: false; code: IssueErrorCode; message: string };

export type IssueRequest = {
  /** Base58 of the connected wallet; it is the fee payer and the `user` signer. */
  wallet: string;
  /** Issuer keypair, decoded from `ISSUER_PRIVATE_KEY` by the caller (see `lib/env.server.ts`). */
  issuer: Keypair;
  challengeId: number;
  score: number;
  evidenceHash: Uint8Array;
};

export type BuildIssueTransactionInput = IssueRequest & {
  connection?: Connection;
  /** Pass the Config the route already fetched; otherwise it is read from RPC and verified. */
  config?: ConfigAccount;
  /** Pass the answer from the route's existence check to skip a second profile read. */
  profileExists?: boolean;
};

const BASE58_PATTERN = /^[1-9A-HJ-NP-Za-km-z]+$/;

/** Rebuild a signing keypair from a 64 byte ed25519 secret key (`solana-keygen` output format). */
export function keypairFromSecretKey(secretKey: Uint8Array | readonly number[]): IssueResult<Keypair> {
  const bytes = secretKey instanceof Uint8Array ? secretKey : Uint8Array.from(secretKey);
  if (bytes.length !== 64) {
    return failure("INVALID_ISSUE_ARGS", `issuer secret key must be 64 bytes, got ${bytes.length}`);
  }
  try {
    return { ok: true, data: Keypair.fromSecretKey(bytes) };
  } catch (error) {
    return failure("INVALID_ISSUE_ARGS", `issuer secret key is invalid: ${describeError(error)}`);
  }
}

/**
 * Pure half of the builder: no RPC and no keypair generation, so it is fully deterministic for a
 * given blockhash. This is what the unit tests exercise.
 */
export function compileIssueTransaction(
  input: IssueRequest & {
    blockhash: string;
    lastValidBlockHeight: number;
    profileExists: boolean;
  },
): IssueResult<IssueTransaction> {
  const parsedWallet = parsePublicKey(input.wallet);
  if (!parsedWallet.ok) {
    return failure("INVALID_WALLET", `wallet: ${parsedWallet.error}`);
  }
  const wallet = parsedWallet.data;

  if (!isChallengeId(input.challengeId)) {
    return failure("INVALID_ISSUE_ARGS", "challenge id must be an integer between 1 and 5");
  }
  if (!isBase58BytesOfLength(input.blockhash, PUBLIC_KEY_LENGTH)) {
    return failure("INVALID_BLOCKHASH", "recent blockhash is not a 32 byte base58 value");
  }

  const programId = getProgramId();
  const profile = profilePda(wallet);
  const credential = credentialPda(wallet, input.challengeId);

  const issue = issueCredentialInstruction({
    user: wallet,
    issuer: input.issuer.publicKey,
    configPda: configPda(programId).pda,
    profilePda: profile.pda,
    credentialPda: credential.pda,
    challengeId: input.challengeId,
    score: input.score,
    evidenceHash: input.evidenceHash,
    programId,
  });
  if (!issue.ok) {
    return failure("INVALID_ISSUE_ARGS", issue.error);
  }

  const instructions: TransactionInstruction[] = [];
  if (!input.profileExists) {
    instructions.push(initializeProfileInstruction({ user: wallet, profilePda: profile.pda, programId }));
  }
  instructions.push(issue.data);

  const message = new TransactionMessage({
    payerKey: wallet,
    recentBlockhash: input.blockhash,
    instructions,
  }).compileToV0Message();

  const transaction = new VersionedTransaction(message);
  transaction.sign([input.issuer]);

  return {
    ok: true,
    data: {
      transaction: Buffer.from(transaction.serialize()).toString("base64"),
      blockhash: input.blockhash,
      lastValidBlockHeight: input.lastValidBlockHeight,
      credentialPda: credential.pda.toBase58(),
      profilePda: profile.pda.toBase58(),
    },
  };
}

/**
 * Fetches what it needs (Config, Profile, blockhash), verifies the issuer matches `Config`, then
 * compiles. Failures are returned as typed results; the route maps `code` to its HTTP status.
 */
export async function buildIssueTransaction(
  input: BuildIssueTransactionInput,
): Promise<IssueResult<IssueTransaction>> {
  const connection = input.connection ?? getConnection();

  const config = input.config !== undefined ? { ok: true as const, data: input.config } : await fetchConfigAccount(connection);
  if (!config.ok) {
    return failure("RPC_ERROR", config.error);
  }
  if (config.data === null) {
    return failure("CONFIG_NOT_INITIALIZED", "the program has no Config account yet; run scripts/init-config.ts");
  }
  if (!config.data.issuer.equals(input.issuer.publicKey)) {
    return failure(
      "ISSUER_MISMATCH",
      `onchain issuer is ${config.data.issuer.toBase58()}, not ${input.issuer.publicKey.toBase58()}`,
    );
  }

  let profileExists = input.profileExists;
  if (profileExists === undefined) {
    const profile = await fetchProfileAccount(connection, input.wallet);
    if (!profile.ok) {
      return failure("RPC_ERROR", profile.error);
    }
    profileExists = profile.data !== null;
  }

  let blockhashInfo: { blockhash: string; lastValidBlockHeight: number };
  try {
    blockhashInfo = await connection.getLatestBlockhash();
  } catch (error) {
    return failure("RPC_ERROR", `blockhash lookup failed: ${describeError(error)}`);
  }

  return compileIssueTransaction({
    wallet: input.wallet,
    issuer: input.issuer,
    challengeId: input.challengeId,
    score: input.score,
    evidenceHash: input.evidenceHash,
    blockhash: blockhashInfo.blockhash,
    lastValidBlockHeight: blockhashInfo.lastValidBlockHeight,
    profileExists,
  });
}

function failure(code: IssueErrorCode, message: string): { ok: false; code: IssueErrorCode; message: string } {
  return { ok: false, code, message };
}

function isBase58BytesOfLength(value: string, length: number): boolean {
  if (!BASE58_PATTERN.test(value)) {
    return false;
  }
  return base58.decode(value).length === length;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
