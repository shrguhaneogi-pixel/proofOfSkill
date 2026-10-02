import { describe, expect, it } from "vitest";

import { ERROR_CATALOG, type ErrorKey } from "./codes";
import { errorFor, isErrorKey, mapAttestationRejection, mapError, mapIssueError } from "./mapping";

const ALL_KEYS = Object.keys(ERROR_CATALOG) as ErrorKey[];

/** Every case `docs/rules.md` → ERROR_UX lists, plus the attestation and env codes. */
const REQUIRED_CASES: readonly [ErrorKey, unknown][] = [
  ["wallet_not_installed", "No Solana wallet is installed in this browser"],
  ["wallet_not_detected", { name: "WalletNotReadyError" }],
  ["wallet_not_connected", { name: "WalletNotConnectedError" }],
  ["wallet_no_response", { name: "WalletWindowBlockedError" }],
  ["user_rejected", { name: "WalletSignTransactionError", message: "User rejected the transaction" }],
  ["user_rejected", { code: 4001, message: "User rejected the request." }],
  ["wrong_network", "The wallet is on the wrong network for this app"],
  ["insufficient_sol", "Simulation failed. Insufficient funds for rent"],
  ["simulation_failed", { name: "SendTransactionError", message: "Simulation failed. Logs: [..]" }],
  ["simulation_failed", { code: -32002, name: "SolanaJSONRPCError" }],
  ["program_rejected", "Error Code: ScoreBelowThreshold"],
  ["issuer_not_authorized", "Error Code: UnauthorizedIssuer"],
  ["blockhash_expired", { name: "TransactionExpiredBlockheightExceededError" }],
  ["blockhash_expired", "Blockhash not found"],
  ["rpc_failed", { name: "SolanaJSONRPCError", code: -32005 }],
  ["rpc_failed", "fetch failed"],
  ["credential_exists", { error: { code: "CREDENTIAL_EXISTS", message: "already issued" } }],
  ["invalid_wallet", new Error("Invalid public key input")],
  ["issuer_not_configured", { code: "ISSUER_NOT_CONFIGURED" }],
  ["ai_not_configured", "AI_API_KEY is not set."],
  ["ai_rate_limited", "429 Too Many Requests from the provider"],
  ["ai_timeout", { code: "AI_TIMEOUT" }],
  ["request_timeout", new Error("The operation timed out")],
  ["ai_invalid_output", "The model returned invalid json"],
  ["ai_upstream_error", "The provider returned an upstream error"],
  ["invalid_submission", { code: "INVALID_SUBMISSION" }],
  ["challenge_not_found", { code: "CHALLENGE_NOT_FOUND" }],
  ["attestation_expired", { ok: false, code: "expired", error: "attestation is past its expiry" }],
  ["attestation_invalid_signature", { ok: false, code: "invalid_signature" }],
  ["attestation_below_threshold", { ok: false, code: "below_threshold" }],
  ["attestation_malformed", { ok: false, code: "malformed" }],
  ["attestation_secret_missing", { ok: false, code: "secret_missing" }],
  ["env_not_configured", { name: "EnvNotConfiguredError" }],
];

describe("error catalogue", () => {
  it("covers the whole ERROR_UX list from docs/rules.md", () => {
    for (const key of [
      "wallet_not_installed",
      "wallet_not_detected",
      "user_rejected",
      "wrong_network",
      "insufficient_sol",
      "simulation_failed",
      "blockhash_expired",
      "rpc_failed",
      "credential_exists",
      "ai_not_configured",
      "ai_rate_limited",
      "ai_timeout",
      "ai_invalid_output",
      "invalid_submission",
      "attestation_expired",
      "attestation_invalid_signature",
      "attestation_below_threshold",
      "attestation_malformed",
      "env_not_configured",
    ] as ErrorKey[]) {
      expect(ERROR_CATALOG[key], `catalogue entry ${key}`).toBeDefined();
    }
  });

  it("gives every key a message and a concrete next step", () => {
    for (const key of ALL_KEYS) {
      const entry = ERROR_CATALOG[key];
      expect(entry.message.trim().length, `${key} message`).toBeGreaterThan(0);
      expect(entry.nextStep.trim().length, `${key} next step`).toBeGreaterThan(0);
      expect(entry.message, `${key} message ends in a period`).toMatch(/\.$/);
      expect(entry.nextStep, `${key} next step ends in a period`).toMatch(/\.$/);
      expect(entry.code).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(entry.status).toBeGreaterThanOrEqual(400);
      expect(entry.status).toBeLessThan(600);
    }
  });

  it("has no message that could interpolate a runtime value", () => {
    for (const key of ALL_KEYS) {
      const entry = ERROR_CATALOG[key];
      for (const text of [entry.message, entry.nextStep]) {
        expect(text).not.toContain("${");
        expect(text).not.toContain("http://127");
        expect(text).not.toMatch(/sk-[A-Za-z0-9]/);
      }
    }
  });
});

describe("mapError", () => {
  it.each(REQUIRED_CASES)("recognises %s", (expected, cause) => {
    expect(mapError(cause).key).toBe(expected);
  });

  it("maps each attestation rejection reason to a machine-readable code", () => {
    const wireCodes = new Map<string, string>();
    for (const reason of [
      "invalid_signature",
      "expired",
      "below_threshold",
      "malformed",
    ] as const) {
      const mapped = mapAttestationRejection(reason);
      expect(mapped.code).toBe("INVALID_ATTESTATION");
      expect(mapped.retryable).toBe(false);
      expect(mapped.message.length).toBeGreaterThan(0);
      wireCodes.set(reason, mapped.message);
    }
    // Each reason gets its own instruction, not one shared sentence.
    expect(new Set(wireCodes.values()).size).toBe(4);
    expect(mapAttestationRejection("secret_missing").code).toBe("ENV_NOT_CONFIGURED");
  });

  it("falls back safely and never echoes the input", () => {
    const secrets = ["Bearer sk-prod-secret-9f3a", "at://Qmbroken", "{ cycle 12 }"];
    for (const secret of secrets) {
      const mapped = mapError(new Error(secret));
      expect(mapped.key).toBe("unknown");
      expect(mapped.code).toBe("UNKNOWN");
      expect(mapped.status).toBe(500);
      expect(mapped.message).not.toContain(secret);
      expect(mapped.nextStep).not.toContain(secret);
    }
  });

  it("handles values that carry no signal at all", () => {
    for (const cause of [undefined, null, 0, false, "", {}, [], Symbol("x")]) {
      expect(mapError(cause).key).toBe("unknown");
    }
  });

  it("does not include the thrown object anywhere in the result", () => {
    const cause = { name: "Error", message: "raw upstream body: {\"api_key\":\"leak\"}" };
    const mapped = mapError(cause);
    expect(JSON.stringify(mapped)).not.toContain("leak");
    expect(JSON.stringify(mapped)).not.toContain("raw upstream body");
  });

  it("uses the hint only when nothing was identified", () => {
    expect(mapError(new Error("complete gibberish with no match"), "credential_exists").key).toBe(
      "credential_exists",
    );
    expect(mapError(new Error("not connected"), "credential_exists").key).toBe(
      "wallet_not_connected",
    );
    expect(mapError(new Error("complete gibberish with no match"), "nope" as ErrorKey).key).toBe(
      "unknown",
    );
  });

  it("exposes the catalogue for callers that already know the key", () => {
    expect(errorFor("rate_limited").code).toBe("RATE_LIMITED");
    expect(errorFor("rate_limited").status).toBe(429);
    expect(isErrorKey("rpc_failed")).toBe(true);
    expect(isErrorKey("toString")).toBe(false);
    expect(isErrorKey("__proto__")).toBe(false);
    expect(isErrorKey(undefined)).toBe(false);
  });
});

describe("mapIssueError", () => {
  it("maps the /api/issue wire codes", () => {
    for (const [code, key] of [
      ["INVALID_ATTESTATION", "attestation_invalid_signature"],
      ["INVALID_WALLET", "invalid_wallet"],
      ["CREDENTIAL_EXISTS", "credential_exists"],
      ["ISSUER_NOT_CONFIGURED", "issuer_not_configured"],
      ["RPC_ERROR", "rpc_failed"],
    ] as const) {
      expect(mapIssueError({ code }).key).toBe(key);
    }
  });

  it("reads an HTTP status when nothing else identifies the failure", () => {
    expect(mapIssueError({ status: 409 }).key).toBe("credential_exists");
    expect(mapIssueError({ status: 502 }).key).toBe("rpc_failed");
    expect(mapIssueError({ status: 503 }).key).toBe("issuer_not_configured");
    expect(mapIssueError(new Error("Request failed with status code 409")).key).toBe(
      "credential_exists",
    );
    expect(mapIssueError({ status: 418 }).key).toBe("unknown");
  });

  it("prefers a real signal over a status", () => {
    expect(mapIssueError({ status: 409, code: "INVALID_WALLET" }).key).toBe("invalid_wallet");
    expect(mapIssueError({ name: "WalletSignTransactionError", status: 400 }).key).toBe(
      "wallet_sign_failed",
    );
  });

  it("reads the shape the issuance hook throws", () => {
    // components/transaction/use-issue-credential.ts attaches the route's code
    // and the HTTP status onto an Error.
    const hookError = (code: string, status: number, message: string): unknown =>
      Object.assign(new Error(message), { code, status });

    expect(mapIssueError(hookError("CREDENTIAL_EXISTS", 409, "already issued")).key).toBe(
      "credential_exists",
    );
    expect(mapIssueError(hookError("INVALID_ATTESTATION", 400, "expired")).key).toBe(
      "attestation_invalid_signature",
    );
    expect(mapIssueError(hookError("RPC_ERROR", 502, "upstream body {\"api_key\":\"leak\"}")).key).toBe(
      "rpc_failed",
    );
    // No code from the server: the status is the only signal left.
    expect(mapIssueError(hookError("ISSUE_FAILED", 503, "issue failed")).key).toBe(
      "issuer_not_configured",
    );
    expect(JSON.stringify(mapIssueError(hookError("RPC_ERROR", 502, "leak")))).not.toContain("leak");
  });

  it("keeps the retry policy the issuance flow promises", () => {
    expect(mapIssueError({ name: "TransactionExpiredBlockheightExceededError" }).retryable).toBe(
      true,
    );
    expect(mapIssueError("fetch failed").retryable).toBe(true);
    expect(mapIssueError("Simulation failed.").retryable).toBe(true);
    expect(mapIssueError({ code: "CREDENTIAL_EXISTS" }).retryable).toBe(false);
    expect(mapIssueError({ code: "INVALID_ATTESTATION" }).retryable).toBe(false);
    expect(mapIssueError({ code: "ISSUER_NOT_CONFIGURED" }).retryable).toBe(false);
  });

  it("returns the UserError shape for every catalogue key", () => {
    for (const key of ALL_KEYS) {
      const mapped = mapIssueError({ code: ERROR_CATALOG[key].code, reason: key });
      expect(typeof mapped.code).toBe("string");
      expect(typeof mapped.message).toBe("string");
      expect(typeof mapped.nextStep).toBe("string");
      expect(typeof mapped.retryable).toBe("boolean");
    }
  });
});
