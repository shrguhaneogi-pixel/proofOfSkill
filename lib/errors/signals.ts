/**
 * Detection tables and signals for `lib/errors/mapping.ts`.
 *
 * Split out of the mapping module because the mapping's job is to answer, while
 * this file's job is to recognise. Nothing here produces user-facing text.
 */
import type { AttestationRejectionCode } from "../attestation/verify";

import { ERROR_CATALOG, type ErrorCode, type ErrorKey } from "./codes";

/** Keys are the `AttestationRejectionCode` union, so a new reason fails the build. */
export const ATTESTATION_REASON_KEYS: Record<AttestationRejectionCode, ErrorKey> = {
  invalid_signature: "attestation_invalid_signature",
  expired: "attestation_expired",
  below_threshold: "attestation_below_threshold",
  wallet_mismatch: "attestation_wallet_mismatch",
  malformed: "attestation_malformed",
  secret_missing: "attestation_secret_missing",
};

/**
 * `Error.name` / class names verified against the installed packages:
 * `@solana/wallet-adapter-base` `lib/cjs/errors.js`,
 * `@solana/wallet-adapter-react` `lib/cjs/errors.js`, and
 * `@solana/web3.js@1.99.0` `lib/index.esm.js`.
 *
 * web3.js `SendTransactionError` is deliberately absent: it does not set `name`
 * and its two message shapes ("Simulation failed." and "…resulted in an error")
 * already route to the right entry through the message table, which keeps a
 * preflight rejection distinct from a send failure.
 */
const NAME_KEYS: Record<string, ErrorKey> = {
  WalletNotReadyError: "wallet_not_detected",
  WalletLoadError: "wallet_not_detected",
  WalletConfigError: "wallet_not_detected",
  WalletNotSelectedError: "wallet_not_connected",
  WalletConnectionError: "wallet_not_connected",
  WalletNotConnectedError: "wallet_not_connected",
  WalletDisconnectedError: "wallet_not_connected",
  WalletDisconnectionError: "wallet_not_connected",
  WalletAccountError: "wallet_not_connected",
  WalletPublicKeyError: "wallet_not_connected",
  WalletKeypairError: "wallet_not_connected",
  WalletTimeoutError: "wallet_no_response",
  WalletWindowBlockedError: "wallet_no_response",
  WalletWindowClosedError: "wallet_no_response",
  WalletSignTransactionError: "wallet_sign_failed",
  WalletSignMessageError: "wallet_sign_failed",
  WalletSignInError: "wallet_sign_failed",
  WalletSendTransactionError: "transaction_send_failed",
  SolanaJSONRPCError: "rpc_failed",
  TransactionExpiredBlockheightExceededError: "blockhash_expired",
  TransactionExpiredTimeoutError: "blockhash_expired",
  TransactionExpiredNonceInvalidError: "blockhash_expired",
  EnvNotConfiguredError: "env_not_configured",
};

/**
 * `SolanaJSONRPCErrorCode` values from `@solana/web3.js@1.99.0` — preflight
 * failure is the node simulating the transaction and rejecting it — plus the
 * `-32603` internal error and the EIP-1193 `4001` a provider sets when the user
 * dismisses its prompt.
 */
const NUMERIC_KEYS: Record<number, ErrorKey> = {
  [-32603]: "rpc_failed",
  [-32002]: "simulation_failed",
  [-32003]: "transaction_send_failed",
  [-32004]: "blockhash_expired",
  [-32005]: "rpc_failed",
  [-32006]: "transaction_send_failed",
  [-32015]: "transaction_send_failed",
  4001: "user_rejected",
};

/**
 * Ordered message shapes, most specific first. A rent failure arrives inside a
 * simulation message, so `insufficient_sol` precedes `simulation_failed`; the
 * program's own error names (`programs/proof_of_skill/src/errors.rs`) precede
 * the generic "program error" text.
 *
 * These are heuristics over text the wallet, web3.js, or the AI provider
 * produces. Explicit identifiers win, so a mis-guessed pattern can only be
 * reached when nothing better was found. Bare HTTP statuses are deliberately
 * absent: `409`/`502`/`503` mean different things per flow, so the flow-specific
 * layer (`mapIssueError`) is the one that reads them.
 */
const MESSAGE_KEYS: readonly (readonly [RegExp, ErrorKey])[] = [
  [/ATTESTATION_SECRET/i, "attestation_secret_missing"],
  [/AI_API_KEY|AI_BASE_URL|AI_MODEL/i, "ai_not_configured"],
  [/ISSUER_PRIVATE_KEY/i, "issuer_not_configured"],
  [/NEXT_PUBLIC_[A-Z_]+/i, "env_not_configured"],
  [/insufficient (funds|lamports|balance)|not enough (sol|lamports)|rent[- ]?exempt|pay for rent/i, "insufficient_sol"],
  [/already (initialized|exists|issued)|credential.{0,20}(exists|already)/i, "credential_exists"],
  [/invalid public key|invalid base58|not a valid (solana )?(account )?(address|public key)/i, "invalid_wallet"],
  [/(wrong|unexpected|different|unsupported) (network|cluster)|network mismatch|expected (devnet|localnet|testnet|mainnet)/i, "wrong_network"],
  [/block ?hash.{0,25}(not found|expired|invalid|out of date)|block height|block not available|transaction.{0,20}expired/i, "blockhash_expired"],
  [/simulation failed|preflight|failed to simulate/i, "simulation_failed"],
  [/UnauthorizedIssuer|UnauthorizedAdmin/i, "issuer_not_authorized"],
  [/InvalidChallengeId|InvalidScore|ScoreBelowThreshold|EmptyEvidenceHash|MathOverflow|ProofError|custom program error|error processing instruction|cross program invocation failed|program error/i, "program_rejected"],
  // The program's own `#[msg]` text, which reads differently from its error name.
  [/passing threshold|score.{0,20}(below|too low)/i, "attestation_below_threshold"],
  [/resulted in an error|transaction.{0,25}(rejected|failed)|signature.{0,20}(already|conflict)/i, "transaction_send_failed"],
  [/no (solana )?wallet|wallet.{0,20}(not installed|not available|not detected|not found|missing)|could not find.{0,15}wallet|provider is not/i, "wallet_not_installed"],
  [/not connected|disconnected|no account selected|wallet.{0,20}(locked|disconnected)/i, "wallet_not_connected"],
  [/popup.{0,20}(blocked|closed)|window.{0,15}closed|no response|did not (respond|answer)/i, "wallet_no_response"],
  [/rate ?limit|too many requests|\b429\b/i, "ai_rate_limited"],
  [/invalid json|could not parse|failed to parse|did not (match|conform).{0,30}(rubric|schema|format)|output.{0,15}(validation|schema) failed|truncated/i, "ai_invalid_output"],
  [/content policy|moderation|provider.{0,15}(error|unavailable)|upstream.{0,15}(error|status)/i, "ai_upstream_error"],
  [/timed? ?out|timeout|ETIMEDOUT|AbortError|deadline exceeded|\b504\b/i, "request_timeout"],
  [/fetch failed|failed to fetch|NetworkError|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|socket hang up|could not connect|value is null|service unavailable|unhealthy|rpc/i, "rpc_failed"],
];

const USER_REJECTED_PATTERN =
  /user.{0,20}(reject|deni|cancel)|(reject|deni|cancel|declin)\w*.{0,30}(transaction|request|signature|message|prompt|popup)|(transaction|request|signature|message).{0,30}(rejected|cancelled|canceled|denied|dismissed)/i;

/** How deep to follow `cause` / wallet-adapter's `error` wrapper chain. */
const MAX_NESTING = 2;

export type Signals = {
  /** Short identifiers: error names, our codes, attestation reasons. */
  tokens: string[];
  /** Free text: messages, which are pattern matched. */
  messages: string[];
  /** Numeric codes from JSON-RPC, wallet providers, and HTTP statuses. */
  numbers: number[];
};

/**
 * Codes that several keys share. The token lookup needs one deterministic
 * answer for them, so the canonical entry is named here instead of depending on
 * catalogue insertion order. Signals that mean something more specific (an
 * attestation reason, the program's `UnauthorizedIssuer`) still reach their own
 * key through the tables above.
 */
const CANONICAL_CODE_KEYS: Partial<Record<ErrorCode, ErrorKey>> = {
  INVALID_ATTESTATION: "attestation_invalid_signature",
  ISSUER_NOT_CONFIGURED: "issuer_not_configured",
  RATE_LIMITED: "rate_limited",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isErrorKey(value: unknown): value is ErrorKey {
  return typeof value === "string" && Object.hasOwn(ERROR_CATALOG, value);
}

/** Contract identifiers: our catalogue keys, our wire codes, attestation reasons. */
function keyFromIdentifier(token: string): ErrorKey | null {
  if (isErrorKey(token)) {
    return token;
  }
  const reason: ErrorKey | undefined = (ATTESTATION_REASON_KEYS as Record<string, ErrorKey>)[token];
  if (reason !== undefined) {
    return reason;
  }
  const canonicalCode = CANONICAL_CODE_KEYS[token.toUpperCase() as ErrorCode];
  if (canonicalCode !== undefined) {
    return canonicalCode;
  }
  const wanted = token.toUpperCase();
  for (const [key, entry] of Object.entries(ERROR_CATALOG)) {
    if (entry.code === wanted) {
      return key as ErrorKey;
    }
  }
  return null;
}

function keyFromName(token: string): ErrorKey | null {
  return NAME_KEYS[token] ?? null;
}

/** Pulls identifiers, free text, and numeric codes out of anything thrown. */
export function gather(cause: unknown): Signals {
  const signals: Signals = { tokens: [], messages: [], numbers: [] };
  collect(cause, 0, signals);
  return signals;
}

function collect(value: unknown, depth: number, out: Signals): void {
  if (depth > MAX_NESTING) {
    return;
  }
  if (typeof value === "string" && value.length > 0) {
    out.tokens.push(value);
    out.messages.push(value);
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const field of ["name", "code", "reason"] as const) {
    const entry = value[field];
    if (typeof entry === "string") {
      out.tokens.push(entry);
    } else if (typeof entry === "number") {
      out.numbers.push(entry);
    }
  }
  if (typeof value.message === "string") {
    out.messages.push(value.message);
  }
  // A `Response`-like object or a fetch wrapper carries the HTTP status here.
  if (typeof value.status === "number") {
    out.numbers.push(value.status);
  }
  const ctor = value.constructor;
  if (typeof ctor === "function") {
    out.tokens.push(ctor.name);
  }
  collect(value.cause, depth + 1, out);
  collect(value.error, depth + 1, out);
}

/**
 * Detection order, most trustworthy signal first: rejection (the user's own
 * action), then contract identifiers we minted ourselves, then numeric
 * JSON-RPC/provider codes — which are more specific than a generic transport
 * class name — then library class names, then message shapes. `null` means
 * "nothing identified it".
 */
export function detectKey(signals: Signals): ErrorKey | null {
  if (signals.numbers.includes(4001)) {
    return "user_rejected";
  }
  for (const message of signals.messages) {
    if (USER_REJECTED_PATTERN.test(message)) {
      return "user_rejected";
    }
  }
  for (const token of signals.tokens) {
    const key = keyFromIdentifier(token);
    if (key !== null) {
      return key;
    }
  }
  for (const code of signals.numbers) {
    const key: ErrorKey | undefined = NUMERIC_KEYS[code];
    if (key !== undefined) {
      return key;
    }
  }
  for (const token of signals.tokens) {
    const key = keyFromName(token);
    if (key !== null) {
      return key;
    }
  }
  for (const message of signals.messages) {
    for (const [pattern, key] of MESSAGE_KEYS) {
      if (pattern.test(message)) {
        return key;
      }
    }
  }
  return null;
}
