import { NextResponse } from "next/server";

import { verifyAttestation } from "@/lib/attestation/verify";
import { parseEnv } from "@/lib/env.server";
import { isChallengeId } from "@/lib/solana/constants";
import { credentialPda } from "@/lib/solana/pdas";
import { fetchCredentialAccount } from "@/lib/solana/queries";
import { evidenceHashFromHex, parsePublicKey } from "@/lib/solana/codecs";
import {
  buildIssueTransaction,
  keypairFromSecretKey,
  type IssueErrorCode,
} from "@/lib/solana/tx-builder.server";
import { getConnection } from "@/lib/solana/connection";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 4_000;

const STATUS_BY_ISSUE_CODE: Record<IssueErrorCode, number> = {
  INVALID_WALLET: 400,
  INVALID_ISSUE_ARGS: 400,
  INVALID_BLOCKHASH: 502,
  CONFIG_NOT_INITIALIZED: 503,
  ISSUER_MISMATCH: 503,
  RPC_ERROR: 502,
};

function fail(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function POST(request: Request) {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return fail(413, "INVALID_ATTESTATION", "That request is too large.");
  }

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    return fail(413, "INVALID_ATTESTATION", "That request is too large.");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail(400, "INVALID_ATTESTATION", "Request body must be JSON.");
  }

  const body = raw as { attestation?: unknown; wallet?: unknown };
  if (typeof body.wallet !== "string") {
    return fail(400, "INVALID_WALLET", "A wallet address is required.");
  }

  // The signature is checked before the payload is trusted at all, so an
  // unauthenticated body can never reach the transaction builder.
  const verified = verifyAttestation(body.attestation);
  if (!verified.ok) {
    return fail(400, "INVALID_ATTESTATION", "That evaluation can no longer be issued.");
  }
  const { challengeId, score, evidenceHash } = verified.data;

  if (!isChallengeId(challengeId)) {
    return fail(400, "INVALID_ATTESTATION", "That attestation names an unknown challenge.");
  }

  const wallet = parsePublicKey(body.wallet);
  if (!wallet.ok) {
    return fail(400, "INVALID_WALLET", "That wallet address is not a valid Solana public key.");
  }

  const hash = evidenceHashFromHex(evidenceHash);
  if (!hash.ok) {
    return fail(400, "INVALID_ATTESTATION", "That attestation carries a malformed evidence hash.");
  }

  const envResult = parseEnv();
  if (!envResult.ok) {
    return fail(500, "SERVER_MISCONFIGURED", "The server is not configured correctly.");
  }
  const env = envResult.data;

  if (env.issuerSecretKey === null) {
    return fail(
      503,
      "ISSUER_NOT_CONFIGURED",
      "The issuer key is not configured on the server, so no credential can be signed.",
    );
  }

  const issuer = keypairFromSecretKey(env.issuerSecretKey);
  if (!issuer.ok) {
    return fail(503, "ISSUER_NOT_CONFIGURED", "The configured issuer key could not be loaded.");
  }

  const connection = getConnection();

  // Checked here so the user gets a specific answer instead of a raw system
  // program failure when `init` hits an address that already exists.
  const { pda: credential_pda } = credentialPda(wallet.data, challengeId);
  const existing = await fetchCredentialAccount(connection, credential_pda);
  if (!existing.ok) {
    return fail(502, "RPC_ERROR", "Could not read the current credential state. Try again.");
  }
  if (existing.data !== null) {
    return fail(409, "CREDENTIAL_EXISTS", "This wallet already holds a credential for that challenge.");
  }

  const built = await buildIssueTransaction({
    wallet: wallet.data.toBase58(),
    issuer: issuer.data,
    challengeId,
    score,
    evidenceHash: hash.data,
    connection,
  });

  if (!built.ok) {
    return fail(
      STATUS_BY_ISSUE_CODE[built.code],
      built.code,
      built.code === "CONFIG_NOT_INITIALIZED"
        ? "The program has no registered issuer yet on this network."
        : "The transaction could not be prepared. Try again.",
    );
  }

  return NextResponse.json(built.data);
}
