/**
 * The single catalogue of user-facing failure text.
 *
 * Every entry answers the two questions `docs/rules.md` → ERROR_UX demands: what
 * happened, in plain language, and what to do next. `code` and `status` are the
 * wire contract from `docs/api-schema.md` (`{ error: { code, message } }`); the
 * fine-grained key is the internal name callers detect on, which is why several
 * keys can share one wire code (the four attestation rejections are all
 * `INVALID_ATTESTATION` on the wire but need different instructions).
 *
 * Text here is static by construction: nothing in this module can interpolate a
 * runtime value, so a mapped message can never leak a stack trace, an env value,
 * or an upstream response body.
 */

/** Wire-level error code returned by a route handler. */
export type ErrorCode =
  | "WALLET_NOT_INSTALLED"
  | "WALLET_NOT_DETECTED"
  | "WALLET_NOT_CONNECTED"
  | "WALLET_NO_RESPONSE"
  | "WALLET_SIGN_FAILED"
  | "USER_REJECTED"
  | "WRONG_NETWORK"
  | "INSUFFICIENT_SOL"
  | "SIMULATION_FAILED"
  | "PROGRAM_ERROR"
  | "TRANSACTION_FAILED"
  | "BLOCKHASH_EXPIRED"
  | "RPC_ERROR"
  | "UPSTREAM_TIMEOUT"
  | "CREDENTIAL_EXISTS"
  | "INVALID_WALLET"
  | "WALLET_MISMATCH"
  | "ISSUER_NOT_CONFIGURED"
  | "AI_NOT_CONFIGURED"
  | "RATE_LIMITED"
  | "AI_TIMEOUT"
  | "AI_INVALID_OUTPUT"
  | "AI_UPSTREAM_ERROR"
  | "INVALID_SUBMISSION"
  | "CHALLENGE_NOT_FOUND"
  | "INVALID_ATTESTATION"
  | "ENV_NOT_CONFIGURED"
  | "UNKNOWN";

/** Internal catalogue keys, most of which mirror `AttestationRejectionCode`. */
export type ErrorKey =
  | "wallet_not_installed"
  | "wallet_not_detected"
  | "wallet_not_connected"
  | "wallet_no_response"
  | "wallet_sign_failed"
  | "user_rejected"
  | "wrong_network"
  | "insufficient_sol"
  | "simulation_failed"
  | "program_rejected"
  | "issuer_not_authorized"
  | "transaction_send_failed"
  | "blockhash_expired"
  | "rpc_failed"
  | "request_timeout"
  | "credential_exists"
  | "invalid_wallet"
  | "issuer_not_configured"
  | "ai_not_configured"
  | "rate_limited"
  | "ai_rate_limited"
  | "ai_timeout"
  | "ai_invalid_output"
  | "ai_upstream_error"
  | "invalid_submission"
  | "challenge_not_found"
  | "attestation_invalid_signature"
  | "attestation_expired"
  | "attestation_below_threshold"
  | "attestation_wallet_mismatch"
  | "attestation_malformed"
  | "attestation_secret_missing"
  | "env_not_configured"
  | "unknown";

export type ErrorEntry = {
  code: ErrorCode;
  status: number;
  /** Whether the UI should offer "Try again": the same step may work on a second attempt. */
  retryable: boolean;
  message: string;
  nextStep: string;
};

export type MappedError = ErrorEntry & { key: ErrorKey };

export const ERROR_CATALOG: Record<ErrorKey, ErrorEntry> = {
  wallet_not_installed: {
    code: "WALLET_NOT_INSTALLED", status: 400, retryable: false,
    message: "This browser has no Solana wallet installed.",
    nextStep: "Install a wallet such as Phantom, reload the page, then connect.",
  },
  wallet_not_detected: {
    code: "WALLET_NOT_DETECTED", status: 400, retryable: false,
    message: "Your wallet is installed, but this page could not reach it.",
    nextStep: "Reload the page and connect again; a wallet-blocking extension can hide it.",
  },
  wallet_not_connected: {
    code: "WALLET_NOT_CONNECTED", status: 400, retryable: false,
    message: "No wallet is connected, so there is no account to pay the fee from.",
    nextStep: "Connect your Solana wallet first, then request the credential again.",
  },
  wallet_no_response: {
    code: "WALLET_NO_RESPONSE", status: 400, retryable: true,
    message: "Your wallet did not answer the request.",
    nextStep: "Allow popups for this site, unlock the wallet, then try again.",
  },
  wallet_sign_failed: {
    code: "WALLET_SIGN_FAILED", status: 400, retryable: false,
    message: "Your wallet refused to sign the transaction.",
    nextStep: "Reconnect the wallet and start the issue step again; if it keeps failing, try another wallet.",
  },
  user_rejected: {
    code: "USER_REJECTED", status: 400, retryable: true,
    message: "You cancelled the request in your wallet, so nothing was submitted.",
    nextStep: "Start the step again and choose Approve in the wallet popup.",
  },
  wrong_network: {
    code: "WRONG_NETWORK", status: 400, retryable: false,
    message: "Your wallet is on a different Solana network than this app.",
    nextStep: "Switch your wallet to the network this app is configured for, then connect again.",
  },
  insufficient_sol: {
    code: "INSUFFICIENT_SOL", status: 400, retryable: false,
    message: "Your wallet does not have enough SOL to pay for the credential account.",
    nextStep: "Fund it with devnet SOL from https://faucet.solana.com, then request the credential again.",
  },
  simulation_failed: {
    code: "SIMULATION_FAILED", status: 400, retryable: true,
    message: "The network rejected the transaction before it was sent, so nothing was spent.",
    nextStep: "Check the dashboard for an existing credential for this challenge, then try again.",
  },
  program_rejected: {
    code: "PROGRAM_ERROR", status: 400, retryable: false,
    message: "The credential program refused to record this credential.",
    nextStep: "Evaluate the submission again and sign the new transaction; if it keeps happening, report the challenge name.",
  },
  issuer_not_authorized: {
    code: "ISSUER_NOT_CONFIGURED", status: 503, retryable: false,
    message: "This server's issuer key is not the one the program accepts.",
    nextStep: "The operator must initialize the Config account with the issuer key set in ISSUER_PRIVATE_KEY, then retry.",
  },
  transaction_send_failed: {
    code: "TRANSACTION_FAILED", status: 502, retryable: true,
    message: "The Solana network rejected the signed transaction.",
    nextStep: "Look at your wallet activity to see whether it landed, then try again.",
  },
  blockhash_expired: {
    code: "BLOCKHASH_EXPIRED", status: 400, retryable: true,
    message: "The transaction expired before it could land onchain.",
    nextStep: "Request the credential again to build a fresh transaction and sign it promptly.",
  },
  rpc_failed: {
    code: "RPC_ERROR", status: 502, retryable: true,
    message: "The Solana network endpoint did not answer.",
    nextStep: "Wait a few seconds and retry; if it keeps failing, run your own RPC endpoint and set NEXT_PUBLIC_SOLANA_RPC_URL.",
  },
  // Domain-neutral fallback: a timeout with nothing in it that says whether the
  // AI or the RPC was the slow side. Callers that do know pass a hint.
  request_timeout: {
    code: "UPSTREAM_TIMEOUT", status: 504, retryable: true,
    message: "The request took too long and was cancelled.",
    nextStep: "Try again; if it keeps happening, check this machine's network connection and the server's RPC endpoint.",
  },
  credential_exists: {
    code: "CREDENTIAL_EXISTS", status: 409, retryable: false,
    message: "This wallet already holds a credential for this challenge.",
    nextStep: "Open the dashboard to see it, or share the public verification link.",
  },
  invalid_wallet: {
    code: "INVALID_WALLET", status: 400, retryable: false,
    message: "That is not a valid Solana account address.",
    nextStep: "Connect the wallet instead of typing an address, or paste the full address from your wallet.",
  },
  issuer_not_configured: {
    code: "ISSUER_NOT_CONFIGURED", status: 503, retryable: false,
    message: "This server is not configured to issue credentials.",
    nextStep: "The operator must set ISSUER_PRIVATE_KEY in .env.local and restart; your submission is fine.",
  },
  ai_not_configured: {
    code: "AI_NOT_CONFIGURED", status: 503, retryable: false,
    message: "No AI evaluator is configured, so submissions cannot be graded.",
    nextStep: "The operator must set AI_API_KEY, AI_BASE_URL and AI_MODEL in .env.local, then restart the app.",
  },
  rate_limited: {
    code: "RATE_LIMITED", status: 429, retryable: true,
    message: "Too many evaluation requests came from this address.",
    nextStep: "Wait about a minute, then submit again.",
  },
  ai_rate_limited: {
    code: "RATE_LIMITED", status: 429, retryable: true,
    message: "The AI evaluator is rate limited right now.",
    nextStep: "Wait a minute and submit again; if it persists, the operator should check the provider quota.",
  },
  ai_timeout: {
    code: "AI_TIMEOUT", status: 504, retryable: true,
    message: "The AI evaluator took too long to answer.",
    nextStep: "Submit the same answers again; the request that timed out was not graded.",
  },
  ai_invalid_output: {
    code: "AI_INVALID_OUTPUT", status: 502, retryable: true,
    message: "The AI evaluator returned feedback that did not match the rubric format.",
    nextStep: "Submit again; if it persists, try once more with a shorter code snippet.",
  },
  ai_upstream_error: {
    code: "AI_UPSTREAM_ERROR", status: 502, retryable: true,
    message: "The AI provider returned an error.",
    nextStep: "Try again in a moment; if it persists, the operator should check AI_BASE_URL and the provider status.",
  },
  invalid_submission: {
    code: "INVALID_SUBMISSION", status: 400, retryable: false,
    message: "The submission is missing something the evaluator needs.",
    nextStep: "Write at least 100 characters of explanation and paste the code to grade; the GitHub link is optional.",
  },
  challenge_not_found: {
    code: "CHALLENGE_NOT_FOUND", status: 404, retryable: false,
    message: "That challenge does not exist.",
    nextStep: "Choose a challenge from the list; the ids run from 1 to 5.",
  },
  attestation_invalid_signature: {
    code: "INVALID_ATTESTATION", status: 400, retryable: false,
    message: "This evaluation result could not be authenticated.",
    nextStep: "Run the evaluation again and issue the credential right after it passes.",
  },
  attestation_expired: {
    code: "INVALID_ATTESTATION", status: 400, retryable: false,
    message: "This evaluation result is too old to issue a credential.",
    nextStep: "Run the evaluation again; a result can only be redeemed for 15 minutes.",
  },
  attestation_below_threshold: {
    code: "INVALID_ATTESTATION", status: 400, retryable: false,
    message: "This evaluation did not reach the score needed for a credential.",
    nextStep: "Work through the rubric feedback and submit again; a credential needs 70 or more.",
  },
  attestation_wallet_mismatch: {
    code: "WALLET_MISMATCH", status: 403, retryable: false,
    message: "That passing evaluation belongs to a different wallet, so it cannot be redeemed here.",
    nextStep: "Connect the wallet that ran the evaluation, or evaluate again while connected to this one.",
  },
  attestation_malformed: {
    code: "INVALID_ATTESTATION", status: 400, retryable: false,
    message: "The credential request was not in the format this server issues.",
    nextStep: "Evaluate the submission again and use the result the page returned, unedited.",
  },
  attestation_secret_missing: {
    code: "ENV_NOT_CONFIGURED", status: 503, retryable: false,
    message: "This server cannot authenticate evaluation results.",
    nextStep: "The operator must set ATTESTATION_SECRET to at least 32 random bytes in .env.local and restart.",
  },
  env_not_configured: {
    code: "ENV_NOT_CONFIGURED", status: 503, retryable: false,
    message: "The server is missing required configuration.",
    nextStep: "The operator must fill in .env.local from .env.example and restart the app.",
  },
  unknown: {
    code: "UNKNOWN", status: 500, retryable: true,
    message: "Something went wrong.",
    nextStep: "Try again; if it keeps happening, note the challenge and the time so the operator can check the server log.",
  },
};
