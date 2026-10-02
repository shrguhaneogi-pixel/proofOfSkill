/**
 * The single place user-facing failure text is produced.
 *
 * Pure module: no DOM, no React, no network, no secrets. `mapError` accepts
 * anything a route handler or a wallet call can throw and returns catalogue
 * text from `./codes`; recognition lives in `./signals`. Because every returned
 * string is a literal in the catalogue, an input can never be echoed back — no
 * stack trace, no env value, and no upstream response body reaches the user
 * through this module.
 */
import type { AttestationRejectionCode } from "../attestation/verify";

import { ERROR_CATALOG, type ErrorKey, type MappedError } from "./codes";
import {
  ATTESTATION_REASON_KEYS,
  detectKey,
  gather,
  isErrorKey,
} from "./signals";

/**
 * What the UI renders for a failure: plain language plus one concrete action.
 * `MappedError` carries two extra fields (`key`, `status`) that route handlers
 * need, and satisfies this shape.
 */
export type UserError = {
  code: string;
  message: string;
  nextStep: string;
  retryable: boolean;
};

/** Catalogue entry for a key, for callers that already know what happened. */
export function errorFor(key: ErrorKey): MappedError {
  return { key, ...ERROR_CATALOG[key] };
}

/** Maps a `verifyAttestation` rejection straight to its user-facing text. */
export function mapAttestationRejection(reason: AttestationRejectionCode): MappedError {
  return errorFor(ATTESTATION_REASON_KEYS[reason]);
}

/**
 * Never throws and never quotes its input. `hint` is used only when nothing in
 * `cause` identified the failure — a route that knows which step it was on can
 * say so, without overriding a real signal.
 */
export function mapError(cause: unknown, hint?: ErrorKey): MappedError {
  const detected = detectKey(gather(cause));
  if (detected !== null) {
    return errorFor(detected);
  }
  if (hint !== undefined && isErrorKey(hint)) {
    return errorFor(hint);
  }
  return errorFor("unknown");
}

/**
 * HTTP statuses `POST /api/issue` answers with, from `docs/api-schema.md`. Only
 * consulted when nothing else identified the failure, because one status can
 * cover several codes (`400` is both `INVALID_ATTESTATION` and `INVALID_WALLET`).
 */
const ISSUE_STATUS_KEYS: Record<number, ErrorKey> = {
  409: "credential_exists",
  502: "rpc_failed",
  503: "issuer_not_configured",
};

const ISSUE_STATUS_TEXT: readonly (readonly [RegExp, ErrorKey])[] = [
  [/\b409\b/, "credential_exists"],
  [/\b502\b/, "rpc_failed"],
  [/\b503\b/, "issuer_not_configured"],
];

/**
 * Entry point for the issuance flow: everything thrown while calling
 * `/api/issue`, signing, sending, or confirming. It is `mapError` plus the
 * status-only signals a fetch wrapper leaves behind.
 */
export function mapIssueError(error: unknown): MappedError {
  const mapped = mapError(error);
  if (mapped.key !== "unknown") {
    return mapped;
  }
  const signals = gather(error);
  for (const value of signals.numbers) {
    const key: ErrorKey | undefined = ISSUE_STATUS_KEYS[value];
    if (key !== undefined) {
      return errorFor(key);
    }
  }
  for (const message of signals.messages) {
    for (const [pattern, key] of ISSUE_STATUS_TEXT) {
      if (pattern.test(message)) {
        return errorFor(key);
      }
    }
  }
  return mapped;
}

export { isErrorKey };
