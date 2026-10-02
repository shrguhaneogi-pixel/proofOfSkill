/**
 * Zod validation for every environment variable in `.env.example`.
 *
 * `next build` runs without a filled-in `.env.local`, so nothing here throws at
 * import time or reads `process.env` at module scope: `parseEnv()` returns a
 * typed result and `requireEnv()` — for use inside a request handler, never at
 * the top of a module — turns the failure into an `EnvNotConfiguredError` the
 * route can map through `lib/errors/mapping.ts`.
 *
 * Server-only, and no message produced here ever contains a value: only the
 * name of the key and how to fix it.
 */
import "server-only";

import { z } from "zod";

import { MIN_KEY_BYTES, keyBytesFromMaterial } from "./attestation/sign";

export const SOLANA_NETWORKS = ["localnet", "devnet", "testnet", "mainnet-beta"] as const;

export type SolanaNetwork = (typeof SOLANA_NETWORKS)[number];

export type EnvKey =
  | "NEXT_PUBLIC_SOLANA_NETWORK"
  | "NEXT_PUBLIC_SOLANA_RPC_URL"
  | "NEXT_PUBLIC_PROGRAM_ID"
  | "AI_API_KEY"
  | "AI_BASE_URL"
  | "AI_MODEL"
  | "ISSUER_PRIVATE_KEY"
  | "ATTESTATION_SECRET";

export type AiEnv = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

export type AppEnv = {
  network: SolanaNetwork;
  rpcUrl: string;
  programId: string;
  /** `null` when no evaluator is configured: `/api/evaluate` answers `AI_NOT_CONFIGURED`. */
  ai: AiEnv | null;
  /** 64-byte ed25519 secret key, or `null` when `/api/issue` should answer `ISSUER_NOT_CONFIGURED`. */
  issuerSecretKey: Uint8Array | null;
  /** Already decoded HMAC key material, validated to at least `MIN_KEY_BYTES`. */
  attestationKeyBytes: Uint8Array;
};

export type EnvResult = { ok: true; data: AppEnv } | { ok: false; error: string[] };

type EnvSource = Readonly<Record<string, string | undefined>>;

/** Setup instructions are the point of these messages, so each key carries its own. */
const KEY_HINTS: Record<EnvKey, string> = {
  NEXT_PUBLIC_SOLANA_NETWORK: `expected one of: ${SOLANA_NETWORKS.join(", ")}`,
  NEXT_PUBLIC_SOLANA_RPC_URL: "expected an http(s) URL for the Solana RPC endpoint",
  NEXT_PUBLIC_PROGRAM_ID: "expected the deployed program id as a base58 string",
  AI_API_KEY: "expected the evaluator API key",
  AI_BASE_URL: "expected an http(s) URL for an OpenAI-compatible chat completions endpoint",
  AI_MODEL: "expected the model identifier to send to the evaluator",
  ISSUER_PRIVATE_KEY: "expected the JSON array of 64 secret-key bytes printed by solana-keygen",
  ATTESTATION_SECRET: `expected secret material that decodes to at least ${MIN_KEY_BYTES} bytes (hex or base64)`,
};

const NETWORK_SCHEMA = z.enum(SOLANA_NETWORKS);
const HTTP_URL_SCHEMA = z.string().regex(/^https?:\/\/\S+$/);
// Shape only; `lib/solana` owns the authoritative PublicKey parse.
const BASE58_SCHEMA = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const ISSUER_SECRET_SCHEMA = z.array(z.int().min(0).max(255)).length(64);

const GENERIC_FAILURE_MESSAGE = "Server environment is not configured.";

/** Missing and invalid are different instructions, so they are different messages. */
function missing(key: EnvKey, errors: string[]): null {
  errors.push(`${key} is not set. Copy .env.example to .env.local and fill it in.`);
  return null;
}

function invalid(key: EnvKey, errors: string[]): null {
  errors.push(`${key} is not valid: ${KEY_HINTS[key]}.`);
  return null;
}

function readRaw(source: EnvSource, key: EnvKey): string | null {
  const value = source[key];
  if (typeof value !== "string") {
    return null;
  }
  // An empty value in .env.local means "not configured", not "configured as empty".
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function readValidated<T>(
  source: EnvSource,
  key: EnvKey,
  schema: z.ZodType<T>,
  errors: string[],
): T | null {
  const raw = readRaw(source, key);
  if (raw === null) {
    return missing(key, errors);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return invalid(key, errors);
  }
  return parsed.data;
}

/**
 * Validates the whole environment. The public trio and `ATTESTATION_SECRET` are
 * required for the app to mean anything; the evaluator and the issuer key are
 * reported as `null` on the data object instead of failing, because a partially
 * configured server still has pages to serve.
 */
export function parseEnv(source: EnvSource = process.env): EnvResult {
  const errors: string[] = [];

  const network = readValidated(source, "NEXT_PUBLIC_SOLANA_NETWORK", NETWORK_SCHEMA, errors);
  const rpcUrl = readValidated(source, "NEXT_PUBLIC_SOLANA_RPC_URL", HTTP_URL_SCHEMA, errors);
  const programId = readValidated(source, "NEXT_PUBLIC_PROGRAM_ID", BASE58_SCHEMA, errors);
  const attestation = parseAttestationSecret(source, errors);
  const ai = parseAiGroup(source, errors);
  const issuerSecretKey = parseIssuerKey(source, errors);

  if (network === null || rpcUrl === null || programId === null || attestation === null) {
    // Each `null` above already pushed a message; the fallback only keeps the
    // narrowing honest without a non-null assertion.
    return { ok: false, error: errors.length > 0 ? errors : [GENERIC_FAILURE_MESSAGE] };
  }
  if (errors.length > 0) {
    return { ok: false, error: errors };
  }

  return {
    ok: true,
    data: { network, rpcUrl, programId, ai, issuerSecretKey, attestationKeyBytes: attestation },
  };
}

function parseAttestationSecret(source: EnvSource, errors: string[]): Uint8Array | null {
  const raw = readRaw(source, "ATTESTATION_SECRET");
  if (raw === null) {
    return missing("ATTESTATION_SECRET", errors);
  }
  const bytes = keyBytesFromMaterial(raw);
  if (bytes === null) {
    return invalid("ATTESTATION_SECRET", errors);
  }
  return bytes;
}

/** All three or none: a key without a base URL or a model cannot be called. */
function parseAiGroup(source: EnvSource, errors: string[]): AiEnv | null {
  const apiKey = readRaw(source, "AI_API_KEY");
  const baseUrl = readRaw(source, "AI_BASE_URL");
  const model = readRaw(source, "AI_MODEL");

  if (apiKey === null) {
    if (baseUrl !== null || model !== null) {
      errors.push(`AI_API_KEY is not set while AI_BASE_URL or AI_MODEL is. ${KEY_HINTS.AI_API_KEY}.`);
    }
    return null;
  }

  if (baseUrl === null) {
    missing("AI_BASE_URL", errors);
  }
  if (model === null) {
    missing("AI_MODEL", errors);
  }
  if (baseUrl === null || model === null) {
    return null;
  }

  if (!HTTP_URL_SCHEMA.safeParse(baseUrl).success) {
    return invalid("AI_BASE_URL", errors);
  }
  return { apiKey, baseUrl, model };
}

function parseIssuerKey(source: EnvSource, errors: string[]): Uint8Array | null {
  const raw = readRaw(source, "ISSUER_PRIVATE_KEY");
  if (raw === null) {
    return null;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    // The parse error would quote the value, which is a secret.
    invalid("ISSUER_PRIVATE_KEY", errors);
    return null;
  }
  const parsed = ISSUER_SECRET_SCHEMA.safeParse(decoded);
  if (!parsed.success) {
    invalid("ISSUER_PRIVATE_KEY", errors);
    return null;
  }
  return Uint8Array.from(parsed.data);
}

/**
 * Thrown by `requireEnv()` only. The message lists key names, never values, so
 * it is safe to surface in a 503 body or a log line.
 */
export class EnvNotConfiguredError extends Error {
  readonly missingKeys: readonly string[];

  constructor(missingKeys: readonly string[]) {
    super(`Server environment is not configured. Set ${missingKeys.join(", ")} in .env.local.`);
    this.name = "EnvNotConfiguredError";
    this.missingKeys = missingKeys;
  }
}

/** Which env keys a failure list mentions — used to pick the right user-facing code. */
export function envKeysIn(messages: readonly string[]): EnvKey[] {
  const keys: EnvKey[] = [];
  for (const key of Object.keys(KEY_HINTS) as EnvKey[]) {
    if (messages.some((message) => message.startsWith(`${key} is not`))) {
      keys.push(key);
    }
  }
  return keys;
}

/** For request handlers, where a missing variable is a deployment bug. */
export function requireEnv(source: EnvSource = process.env): AppEnv {
  const result = parseEnv(source);
  if (result.ok) {
    return result.data;
  }
  // Prefer the bare key names; the full messages are a value-free fallback for a
  // failure that names nothing.
  const keys = envKeysIn(result.error);
  throw new EnvNotConfiguredError(keys.length > 0 ? keys : result.error);
}
