/**
 * Transport-facing failure handling for the evaluator: the deadline and the
 * mapping from "whatever the transport threw" to a stable, user-safe error code
 * (api-schema.md → ROUTES status table).
 *
 * Kept separate from `evaluator.ts` so the attempt loop stays readable.
 */

import type {
  ChatCompletionClient,
  EvaluationErrorCode,
  EvaluationFailure,
  EvaluatorRequestBody,
  EvaluatorResponseBody,
} from "./types";

/** Raised by our own deadline, not by the transport. */
export class EvaluationDeadline extends Error {
  constructor(timeoutMs: number) {
    super(`evaluation call exceeded ${timeoutMs}ms`);
    this.name = "EvaluationDeadline";
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `Reflect.get` keeps upstream error inspection cast-free (no `any`). */
function readProperty(error: unknown, key: string): unknown {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  return Reflect.get(error, key);
}

function httpStatus(error: unknown): number | undefined {
  const status = readProperty(error, "status");
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

function errorText(error: unknown): string {
  const name = readProperty(error, "name");
  const message = error instanceof Error ? error.message : "";
  return `${typeof name === "string" ? name : ""} ${message}`;
}

/**
 * The SDK's own timeout surfaces as `APIConnectionTimeoutError`
 * ("Request timed out.") or an abort — `node_modules/openai/core/error.mjs:67-84`.
 * Matched structurally so a stub, or a future non-OpenAI transport, maps the same
 * way without importing SDK classes into the decision path.
 */
function looksLikeTimeout(error: unknown): boolean {
  return /timed out|timeout|etimedout|abort/i.test(errorText(error));
}

function looksLikeConnectionFailure(error: unknown): boolean {
  return /connection error|fetch failed|econnreset|enotfound|econnrefused|socket hang up|networkerror/i.test(
    errorText(error),
  );
}

function failure(code: EvaluationErrorCode, message: string, retryable: boolean): EvaluationFailure {
  return { code, message, retryable };
}

/**
 * Messages are written here and never copied from `error.message`: the spec
 * forbids leaking raw upstream responses. Only the HTTP status number is echoed,
 * and it is our own transport's number.
 */
export function classifyUpstreamError(error: unknown): EvaluationFailure {
  if (error instanceof EvaluationDeadline || looksLikeTimeout(error)) {
    return failure("AI_TIMEOUT", "The AI provider took too long to answer. Please try again.", true);
  }

  const status = httpStatus(error);
  if (status === 401 || status === 403) {
    return failure(
      "AI_NOT_CONFIGURED",
      "The configured AI credentials were rejected by the provider. Check AI_API_KEY, AI_BASE_URL and AI_MODEL.",
      false,
    );
  }
  if (status === 429) {
    return failure("AI_UPSTREAM_ERROR", "The AI provider is rate limiting requests. Please try again shortly.", true);
  }
  if (status !== undefined && status >= 500) {
    return failure("AI_UPSTREAM_ERROR", "The AI provider returned a server error. Please try again.", true);
  }
  if (status !== undefined) {
    return failure(
      "AI_UPSTREAM_ERROR",
      `The AI provider refused the request (HTTP ${status}). Check that AI_MODEL is available at AI_BASE_URL.`,
      false,
    );
  }
  if (looksLikeConnectionFailure(error)) {
    return failure("AI_UPSTREAM_ERROR", "Could not reach the AI provider. Please try again.", true);
  }
  return failure("AI_UPSTREAM_ERROR", "The AI evaluation failed unexpectedly. Please try again.", false);
}

/** Enforces the deadline even if the transport ignores it. */
export async function callWithinDeadline(
  client: ChatCompletionClient,
  body: EvaluatorRequestBody,
  timeoutMs: number,
): Promise<EvaluatorResponseBody> {
  let cancel: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => reject(new EvaluationDeadline(timeoutMs)), timeoutMs);
    cancel = () => {
      clearTimeout(timer);
    };
  });

  try {
    return await Promise.race([client.create(body), deadline]);
  } finally {
    // Always cleared, so a settled race never leaves a pending timer holding the
    // event loop or firing a stray rejection.
    cancel?.();
  }
}
