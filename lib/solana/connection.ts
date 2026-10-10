/**
 * RPC transport for the app. One place decides which endpoint, commitment, deadline and retry
 * budget are used.
 *
 * `NEXT_PUBLIC_SOLANA_RPC_URL` overrides the public endpoint because the shared devnet RPC is
 * rate limited (docs/stack.md → ANCHOR_WORKSPACE_NOTES). Nothing here reads secrets, so the module
 * is safe for both the browser bundle and route handlers.
 *
 * Resilience has two halves, deliberately separated:
 * - the per-request **deadline** is universal — it is attached to the `Connection` itself, so
 *   every existing caller (`app/verify/[credentialId]`, `/api/issue`, the read layer) stops
 *   hanging on an endpoint that accepted the TCP connection and then said nothing;
 * - **retry and failover** are opt-in through `withRpcRetry`, because only the call site knows
 *   whether re-running it is safe. See `ReplaySafeOptions` below.
 *
 * Env is read at call time, never at import time (`lib/env.server.ts` owns validation).
 */

import {
  Connection,
  clusterApiUrl,
  type Cluster,
  type ConnectionConfig,
  type Finality,
} from "@solana/web3.js";

/** `localnet` is not a web3.js `Cluster`; it needs an explicit endpoint instead of `clusterApiUrl`. */
export type NetworkCluster = Cluster | "localnet";

export const DEFAULT_NETWORK: NetworkCluster = "devnet";
export const DEFAULT_COMMITMENT: Finality = "confirmed";
export const LOCALNET_RPC_URL = "http://127.0.0.1:8899";

/**
 * One RPC round trip may not outlive the request that started it. 8s is under the typical
 * 10s proxy idle timeout and well under the evaluator's 45s (`evaluator.ts` →
 * `DEFAULT_TIMEOUT_MS`), so an unhealthy endpoint cannot turn a page render into a hang.
 */
export const DEFAULT_RPC_TIMEOUT_MS = 8_000;
/** Total tries across all endpoints, not per endpoint: one slow endpoint cannot double the budget. */
export const DEFAULT_RPC_MAX_ATTEMPTS = 3;
export const DEFAULT_RPC_BASE_DELAY_MS = 250;
export const DEFAULT_RPC_MAX_DELAY_MS = 2_000;

/**
 * Optional second endpoint for failover. Read at call time and never required: absence simply
 * means one endpoint. Both names are accepted so the override can be server-only
 * (`SOLANA_RPC_URL_BACKUP`, no `NEXT_PUBLIC_` prefix, so it never reaches the browser bundle)
 * or shared (`NEXT_PUBLIC_SOLANA_RPC_URL_BACKUP`). It is not in `.env.example` yet — adding a
 * required key there is the route owner's call, see `lib/env.server.ts`.
 */
export const BACKUP_RPC_URL_KEYS = ["SOLANA_RPC_URL_BACKUP", "NEXT_PUBLIC_SOLANA_RPC_URL_BACKUP"] as const;

const NETWORKS: readonly NetworkCluster[] = ["devnet", "testnet", "mainnet-beta", "localnet"];

export function isNetworkCluster(value: string): value is NetworkCluster {
  return (NETWORKS as readonly string[]).includes(value);
}

/** Reads `NEXT_PUBLIC_SOLANA_NETWORK`, falling back to devnet when unset or unrecognized. */
export function resolveNetwork(value: string | undefined = process.env.NEXT_PUBLIC_SOLANA_NETWORK): NetworkCluster {
  const candidate = (value ?? "").trim().toLowerCase();
  if (candidate === "") {
    return DEFAULT_NETWORK;
  }
  // A typo such as "devnet1" must not silently talk to another cluster than the developer asked for.
  if (isNetworkCluster(candidate)) {
    return candidate;
  }
  throw new Error(
    `NEXT_PUBLIC_SOLANA_NETWORK is "${value}"; expected one of ${NETWORKS.join(", ")}`,
  );
}

/** Reads `NEXT_PUBLIC_SOLANA_RPC_URL`, falling back to the cluster's public endpoint. */
export function resolveRpcUrl(
  network: NetworkCluster = resolveNetwork(),
  urlOverride: string | undefined = process.env.NEXT_PUBLIC_SOLANA_RPC_URL,
): string {
  const configured = (urlOverride ?? "").trim();
  if (configured !== "") {
    return configured;
  }
  return network === "localnet" ? LOCALNET_RPC_URL : clusterApiUrl(network);
}

/** The configured secondary endpoint, or `null`. Blank, invalid, or same-as-primary all mean none. */
export function resolveBackupRpcUrl(
  primary: string,
  source: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  for (const key of BACKUP_RPC_URL_KEYS) {
    const configured = (source[key] ?? "").trim();
    if (configured !== "" && configured !== primary) {
      return configured;
    }
  }
  return null;
}

const connectionCache = new Map<string, Connection>();

export type GetConnectionOptions = {
  network?: NetworkCluster;
  rpcUrl?: string;
  commitment?: Finality;
  /**
   * Per-request deadline for this endpoint. Part of the cache key, because the deadline is
   * baked into the `fetch` the `Connection` was built with.
   */
  timeoutMs?: number;
};

/**
 * Memoized per endpoint + commitment + deadline, so repeated Server Component renders share one
 * connection. Existing callers pass nothing and get `DEFAULT_RPC_TIMEOUT_MS`.
 */
export function getConnection(options: GetConnectionOptions = {}): Connection {
  const network = options.network ?? resolveNetwork();
  const endpoint = options.rpcUrl ?? resolveRpcUrl(network, options.rpcUrl);
  const commitment = options.commitment ?? DEFAULT_COMMITMENT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  const key = `${endpoint}|${commitment}|${timeoutMs}`;

  const existing = connectionCache.get(key);
  if (existing) {
    return existing;
  }
  const connection = new Connection(endpoint, {
    commitment,
    fetch: createBoundedFetch(timeoutMs, endpoint),
    // web3.js retries a 429 five times with its own 500ms→8s backoff and prints each one to
    // `console.error`. That is a second, unbounded, unobservable retry policy underneath ours:
    // it defeats the deadline, hides the retry count from the log, and its error text
    // ("429 Too Many Requests: …") is misfiled by `lib/errors/signals.ts` as an *AI* rate limit.
    // Turning it off makes `withRpcRetry` the only retry path in the app.
    disableRetryOnRateLimit: true,
  });
  connectionCache.set(key, connection);
  return connection;
}

/** Test seam: drop every memoized connection (a fixture that changes endpoint or deadline). */
export function clearConnectionCache(): void {
  connectionCache.clear();
}

/* -------------------------------------------------------------------------- *
 * The deadline.
 * -------------------------------------------------------------------------- */

/**
 * Both messages are deliberately free of digits and of the words "rate limit", "too many
 * requests", "429"/"502"/"504", and carry no response body.
 *
 * WHY: `lib/errors/signals.ts` classifies failures by pattern-matching `Error.message`
 * (`/rate ?limit|too many requests|\b429\b/i` → `ai_rate_limited`; `/timed? ?out|…|\b504\b/i`
 * → `request_timeout`). An RPC 429 whose message quotes the status would be shown to the user
 * as an AI rate limit, and the raw body of a 5xx from a proxy is often HTML or an echo of the
 * request — never something to put in a log line or a 502 response. The status stays available
 * as a *field* (`error.status`), which is where the retry classifier and the log record read
 * it, and `ERROR_UX` keeps owning the words the user sees.
 */
export class RpcTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly endpoint: string;

  constructor(timeoutMs: number, endpoint: string) {
    super(`Solana RPC request timed out`);
    this.name = "RpcTimeoutError";
    this.timeoutMs = timeoutMs;
    this.endpoint = endpoint;
  }
}

export class RpcHttpStatusError extends Error {
  readonly status: number;
  readonly endpoint: string;

  constructor(status: number, endpoint: string) {
    super(`Solana RPC endpoint did not answer the request`);
    this.name = "RpcHttpStatusError";
    this.status = status;
    this.endpoint = endpoint;
  }
}

type RpcFetch = NonNullable<ConnectionConfig["fetch"]>;

/**
 * Wraps the global fetch with a per-request deadline and a status check.
 *
 * Two things web3.js v1 cannot do for itself, verified against `@solana/web3.js@1.99.0`
 * (`lib/index.esm.js:5204-5245`): it puts no `signal` on the JSON-RPC request, and it does not
 * reject a non-2xx response — it stringifies `status statusText: <body>` into an `Error`,
 * dragging a provider's HTML error page into our error text. Replacing `fetch` is the supported
 * seam (`ConnectionConfig.fetch`, `lib/index.d.ts:3232`), so both are fixed here.
 */
function createBoundedFetch(timeoutMs: number, endpoint: string): RpcFetch {
  return async (input, init) => {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const upstream = init?.signal ?? null;
    const onUpstreamAbort = () => controller.abort();
    if (upstream) {
      if (upstream.aborted) {
        controller.abort();
      } else {
        upstream.addEventListener("abort", onUpstreamAbort, { once: true });
      }
    }

    let response: Response;
    try {
      response = await fetch(input, { ...init, signal: controller.signal });
    } catch (error) {
      // A timeout is our condition; every other transport failure (ECONNREFUSED, ECONNRESET,
      // "fetch failed", a socket hang-up) is rethrown untouched so the message the existing
      // detection tables were built against still reaches `lib/errors/mapping.ts`.
      if (timedOut) {
        throw new RpcTimeoutError(timeoutMs, endpoint);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      upstream?.removeEventListener("abort", onUpstreamAbort);
    }

    if (!response.ok) {
      // The body is dropped: it is a provider's error page, and leaving it unread would pin
      // the socket in undici.
      void response.body?.cancel().catch(() => undefined);
      throw new RpcHttpStatusError(response.status, endpoint);
    }
    return response;
  };
}

/* -------------------------------------------------------------------------- *
 * Retry classification.
 * -------------------------------------------------------------------------- */

/**
 * `transport`/`timeout`/`rate-limit`/`server` are worth another attempt; `json-rpc` and `client`
 * are a considered answer from a node that is healthy, and replaying them only adds load.
 * `unknown` is not retried: a failure we cannot name is a failure we cannot promise is safe to
 * repeat.
 */
export type RpcFailureClass =
  | "timeout"
  | "transport"
  | "rate-limit"
  | "server"
  | "json-rpc-server"
  | "json-rpc"
  | "client"
  | "unknown";

const RETRYABLE_CLASSES: readonly RpcFailureClass[] = ["timeout", "transport", "rate-limit", "server", "json-rpc-server"];

/**
 * JSON-RPC codes that mean "this node could not serve it *now*", taken from
 * `SolanaJSONRPCErrorCode` in the installed `@solana/web3.js@1.99.0` (`lib/index.d.ts:3871-3884`,
 * names verified there and used verbatim): block not available and block status not available yet
 * (`-32004`/`-32014`, a node that is a few slots behind — a different endpoint answers them),
 * unhealthy node (`-32005`), slot skipped and long-term-storage slot skipped (`-32007`/`-32009`),
 * interrupted scan (`-32012`), min context slot not reached (`-32016`), plus the generic internal
 * error `-32603`, which web3.js itself files under `rpc_failed`.
 *
 * Everything else is a decision about *this* request and is not replayed: `-32001` block cleaned
 * up, `-32002` preflight/simulation failure, `-32003`/`-32006`/`-32013` signature and
 * precompile rejections, `-32015` unsupported transaction version.
 */
const RETRYABLE_JSON_RPC_CODES: readonly number[] = [-32004, -32005, -32007, -32009, -32012, -32014, -32016, -32603];

const TRANSPORT_PATTERN = /ECONNREFUSED|ECONNRESET|ECONNABORTED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EMFILE|socket hang up|fetch failed|failed to fetch|NetworkError|Client network socket|other side closed|connection closed/i;
const TIMEOUT_PATTERN = /timed out|timeout|AbortError|TimeoutError|deadline exceeded/i;

export type RpcFailure = { class: RpcFailureClass; retryable: boolean };

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Walks the error and one level of `cause`/`error` (the same shape
 * `lib/errors/signals.ts` reads) and names the failure class.
 */
export function classifyRpcFailure(error: unknown): RpcFailure {
  const detail = inspect(error, 0);
  return { class: detail, retryable: RETRYABLE_CLASSES.includes(detail) };
}

function inspect(error: unknown, depth: number): RpcFailureClass {
  if (error instanceof RpcTimeoutError) {
    return "timeout";
  }
  if (typeof error !== "object" || error === null) {
    const text = String(error ?? "");
    if (TIMEOUT_PATTERN.test(text)) {
      return "timeout";
    }
    return TRANSPORT_PATTERN.test(text) ? "transport" : "unknown";
  }
  if (depth > 2) {
    return "unknown";
  }

  const record = error as { name?: unknown; message?: unknown; code?: unknown; status?: unknown; cause?: unknown; error?: unknown };
  const name = typeof record.name === "string" ? record.name : "";
  const message = typeof record.message === "string" ? record.message : "";
  const status = readNumber(record.status);
  const code = readNumber(record.code);

  // Status first: `RpcHttpStatusError` carries the HTTP code, and a web3.js 429/5xx is a
  // transport-tier problem regardless of what the message says.
  if (status !== null) {
    if (status === 429) {
      return "rate-limit";
    }
    if (status >= 500) {
      return "server";
    }
    if (status >= 400) {
      return "client";
    }
  }
  if (name === "RpcTimeoutError" || name === "TimeoutError" || name === "AbortError" || TIMEOUT_PATTERN.test(message)) {
    return "timeout";
  }
  if (code !== null && code < 0) {
    return RETRYABLE_JSON_RPC_CODES.includes(code) ? "json-rpc-server" : "json-rpc";
  }
  if (TRANSPORT_PATTERN.test(message) || name === "FetchError" || name === "TypeError") {
    return "transport";
  }
  const nested = inspect(record.cause, depth + 1);
  if (nested !== "unknown") {
    return nested;
  }
  const wrapped = inspect(record.error, depth + 1);
  if (wrapped !== "unknown") {
    return wrapped;
  }
  return "unknown";
}

/* -------------------------------------------------------------------------- *
 * Retry and failover.
 * -------------------------------------------------------------------------- */

export type RpcRetryAttempt = {
  /** 1-based, counting every endpoint, so `attempt === maxAttempts` is the last try. */
  attempt: number;
  endpoint: string;
  failedEndpoint: string;
  /** How long the caller will be blocked before the next try. */
  delayMs: number;
  failureClass: RpcFailureClass;
  error: unknown;
};

export type RpcCallOptions = {
  /**
   * The connection to start from. When it is supplied it is used as-is for the first attempt —
   * its own commitment and deadline are preserved — and only a failover builds a new one.
   * When it is omitted, `getConnection()` resolves the primary endpoint.
   */
  connection?: Connection;
  network?: NetworkCluster;
  rpcUrl?: string;
  commitment?: Finality;
  /** Explicit failover order; overrides `connection`/`rpcUrl`/backup env. */
  endpoints?: readonly string[];
  timeoutMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Half the delay at least, the full delay at most, so a fleet of retries does not sync up. */
  jitter?: boolean;
  signal?: AbortSignal;
  /** Telemetry seam: report each failed attempt without swallowing the original error. */
  onRetry?: (info: RpcRetryAttempt) => void;
  /** Test seam for the backoff wait. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /**
   * `true` (default) means re-running the operation is a no-op against a healthy node: a read,
   * or a `getLatestBlockhash`-style lookup. Set it `false` for anything that puts bytes on the
   * network, and only *definitive* refusals are retried (see below).
   */
  replaySafe?: boolean;
};

/**
 * The rule this encodes, stated once because it is easy to get wrong:
 *
 * - Re-sending the **same serialized transaction** after a timeout is safe on Solana. The
 *   signature is over the message, which contains the blockhash, so a duplicate lands once and
 *   the network drops the rest (`BlockhashNotFound` if the blockhash has aged out).
 * *Rebuilding* the transaction with a **fresh blockhash** is not: that is a second, distinct
 *   transaction, and both can land. So a retry closure must freeze its blockhash outside the
 *   retried body — `buildIssueTransaction` already does, which is why the app is safe today.
 * - A timeout or a dropped connection means *unknown outcome*: the node may have processed the
 *   request. Under `replaySafe: false` those are not retried at all.
 * - An HTTP 429/4xx or a JSON-RPC error means the request was refused before it was processed,
 *   so even a send may be re-attempted — against the other endpoint, which is the point of
 *   failover.
 * - Reads are idempotent, so with `replaySafe: true` everything retryable is retried. Note the
 *   trade an operator should know about: a secondary endpoint may be a few slots behind, so a
 *   failover can return a slightly staler account. Every guard in this program is enforced
 *   onchain (`init` on an existing credential PDA fails), so a stale read can waste a
 *   transaction fee but cannot mint a duplicate credential.
 */
export async function withRpcRetry<T>(
  operation: (connection: Connection, endpoint: string) => Promise<T>,
  options: RpcCallOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_RPC_MAX_ATTEMPTS);
  const replaySafe = options.replaySafe ?? true;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_RPC_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_RPC_MAX_DELAY_MS;
  const jitter = options.jitter ?? true;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const endpoints = resolveEndpointConnections(options);
  const aborted = () => abortedError(options.signal);

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const target = endpoints[(attempt - 1) % endpoints.length];

    const failure = aborted();
    if (failure !== null) {
      throw failure;
    }
    try {
      return await operation(target.connection, target.url);
    } catch (error) {
      lastError = error;
      const cancelled = aborted();
      if (cancelled !== null) {
        throw cancelled;
      }
      const classified = classifyRpcFailure(error);
      const retryableForThisCaller = classified.retryable && (replaySafe || isDefinitiveRefusal(classified.class));
      if (!retryableForThisCaller || attempt === maxAttempts) {
        // Rethrow the original error, undecorated. `lib/errors/signals.ts` maps on class name,
        // `code`, `status` and message patterns; wrapping it here would change what the user is
        // told (`ERROR_UX`) for a problem that is purely about *how often* we asked.
        throw error;
      }
      const rawDelay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const delayMs = jitter ? Math.round(rawDelay * (0.5 + random() / 2)) : rawDelay;
      options.onRetry?.({
        attempt,
        endpoint: endpoints[attempt % endpoints.length].url,
        failedEndpoint: target.url,
        delayMs,
        failureClass: classified.class,
        error,
      });
      await sleep(delayMs);
    }
  }
  // Unreachable: the loop throws on its last attempt. Kept so the return type is honest.
  throw lastError instanceof Error ? lastError : new Error("Solana RPC request failed");
}

/** A refusal that proves the node did not process the request. */
function isDefinitiveRefusal(classification: RpcFailureClass): boolean {
  return classification === "rate-limit" || classification === "client" || classification === "json-rpc";
}

function abortedError(signal: AbortSignal | undefined): Error | null {
  if (signal?.aborted !== true) {
    return null;
  }
  const reason = signal.reason;
  if (reason instanceof Error) {
    return reason;
  }
  const error = new Error("The request was cancelled before the Solana RPC call completed");
  error.name = "AbortError";
  return error;
}

type EndpointTarget = { url: string; connection: Connection };

/** Primary first, then the configured secondary; duplicates are collapsed so one endpoint is not tried twice. */
function resolveEndpointConnections(options: RpcCallOptions): EndpointTarget[] {
  const build = (url: string): EndpointTarget => ({
    url,
    connection: getConnection({
      network: options.network,
      rpcUrl: url,
      commitment: options.commitment,
      timeoutMs: options.timeoutMs,
    }),
  });

  if (options.endpoints && options.endpoints.length > 0) {
    const seen = new Set<string>();
    return options.endpoints.filter((url) => {
      if (seen.has(url)) {
        return false;
      }
      seen.add(url);
      return true;
    }).map(build);
  }

  const primaryUrl = options.connection
    ? options.connection.rpcEndpoint
    : resolveRpcUrl(options.network, options.rpcUrl);
  const primary: EndpointTarget = options.connection
    ? { url: primaryUrl, connection: options.connection }
    : build(primaryUrl);
  const backupUrl = resolveBackupRpcUrl(primaryUrl);
  return backupUrl === null ? [primary] : [primary, build(backupUrl)];
}

/** The endpoints a caller would be tried against, in order — for a log line or a status page. */
export function resolveRpcEndpoints(options: { network?: NetworkCluster; rpcUrl?: string } = {}): string[] {
  const primary = options.rpcUrl ?? resolveRpcUrl(options.network);
  const backup = resolveBackupRpcUrl(primary);
  return backup === null ? [primary] : [primary, backup];
}
