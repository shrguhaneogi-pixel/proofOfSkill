/**
 * Rate limiting for the endpoints that buy something per call — today
 * `/api/evaluate`, which pays an LLM provider for every submission it grades.
 *
 * One factory, two backends:
 *
 * - **distributed** — an Upstash Redis sliding window, selected whenever the
 *   caller supplies `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`.
 * - **in-process** — the original fixed-window map, kept as the fallback for
 *   local dev and for any deploy that has no Redis attached.
 *
 * Why the distributed backend exists at all: an in-process counter lives in one
 * Node process, so behind N instances the effective budget is `maxRequests * N`
 * and every cold start hands the client a fresh budget. On serverless, where a
 * request may get its own isolate, that is not a weak limit, it is no limit —
 * and the thing it protects is a per-call invoice. The number has to be kept
 * outside the process for it to mean anything.
 *
 * Why a *sliding* window for the paid path: a fixed window lets a client spend
 * `maxRequests` just before a boundary and `maxRequests` again just after, so
 * the real worst case against the upstream is 2x the advertised limit for a
 * few seconds. `Ratelimit.slidingWindow` weights the previous window by how far
 * into the current one we are, so "8 per 10 minutes" costs at most 8 upstream
 * calls no matter where the window boundary falls.
 *
 * Server-only: the distributed backend is built from a Redis token, so this
 * module must never reach a client bundle.
 */
import "server-only";

import { Ratelimit, type Duration } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

/**
 * In-memory fixed-window limiter.
 *
 * Deliberately MVP-grade and documented as such: state lives in this process, so
 * it resets on restart and is per-instance behind a multi-instance deploy. It
 * exists to stop an accidental or casual flood from spending evaluator credits,
 * not to be a distributed firewall. It is also the fallback used by
 * {@link createRateLimiterWithFallback} when no Upstash config is present, which
 * is why it stays exported under its original name.
 */

export type RateLimitResult = {
  ok: boolean;
  retryAfterSeconds: number;
  remaining: number;
};

type Bucket = { count: number; windowStartMs: number };

export type RateLimiter = {
  check(key: string, nowMs?: number): RateLimitResult;
  /** Exposed for tests and for a future eviction hook. */
  size(nowMs?: number): number;
};

const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS = 8;
/** Buckets idle longer than this are dropped so the map cannot grow unbounded. */
const SWEEP_AFTER_MS = 60 * 60 * 1000;

export function createRateLimiter(
  options: { windowMs?: number; maxRequests?: number } = {},
): RateLimiter {
  const windowMs = options.windowMs ?? WINDOW_MS;
  const maxRequests = options.maxRequests ?? MAX_REQUESTS;
  const buckets = new Map<string, Bucket>();

  function sweep(nowMs: number): void {
    for (const [key, bucket] of buckets) {
      if (nowMs - bucket.windowStartMs > SWEEP_AFTER_MS) {
        buckets.delete(key);
      }
    }
  }

  return {
    check(key: string, nowMs: number = Date.now()): RateLimitResult {
      sweep(nowMs);
      const bucket = buckets.get(key);

      if (!bucket || nowMs - bucket.windowStartMs >= windowMs) {
        buckets.set(key, { count: 1, windowStartMs: nowMs });
        return { ok: true, retryAfterSeconds: 0, remaining: maxRequests - 1 };
      }

      if (bucket.count >= maxRequests) {
        const waitedMs = nowMs - bucket.windowStartMs;
        return {
          ok: false,
          retryAfterSeconds: Math.max(1, Math.ceil((windowMs - waitedMs) / 1000)),
          remaining: 0,
        };
      }

      bucket.count += 1;
      return { ok: true, retryAfterSeconds: 0, remaining: maxRequests - bucket.count };
    },
    size(nowMs: number = Date.now()): number {
      sweep(nowMs);
      return buckets.size;
    },
  };
}

/**
 * Extracts a client identity from the request headers. `x-forwarded-for` is the
 * first hop; a missing header means we fall back to a shared bucket rather than
 * failing open per-client.
 */
export function clientKey(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) {
      return first;
    }
  }
  return "shared";
}

/* -------------------------------------------------------------------------- *
 * Distributed backend: an Upstash Redis sliding window
 * -------------------------------------------------------------------------- */

/** Which backend answered a `check()`. */
export type RateLimitBackend = "distributed" | "in-process";

/**
 * Why a request was declined, and the two are different incidents.
 * `limit-exceeded` is one client being told to slow down; `redis-outage` means
 * the limiter is blind and *everyone* is being declined, which is an operator
 * page, not a user error. Exposed so the route can log or map them separately.
 */
export type RateLimitDecline = "limit-exceeded" | "redis-outage";

/** What to do when the distributed backend cannot be consulted. */
export type RedisOutagePolicy = "fail-open" | "fail-closed";

/**
 * The outage decision, named in one place rather than buried in a branch:
 * **fail closed** (decline).
 *
 * `/api/evaluate` pays an LLM provider per accepted call, so this limiter is the
 * only thing between "Redis was unreachable for 40 seconds" and unbounded
 * spend. Fail-open turns a blip into an invitation: anyone who can *cause* or
 * merely wait for an outage gets an unmetered paid endpoint, and the in-process
 * fallback cannot rescue it, because every instance would separately allow its
 * own `maxRequests` — which is exactly the arithmetic that made the local
 * limiter useless in the first place. The costs are asymmetric too: a declined
 * submission costs one user a retry, an accepted flood costs credits that are
 * gone whichever way we guessed.
 *
 * The counter-argument is availability, and it is legitimate — so this is an
 * option (`outagePolicy`), not a hard-coded reflex. A deployment whose
 * evaluation is cheap enough to rather serve than guard passes `"fail-open"`
 * and gets an allow with the same `cause` recorded. A *malformed* answer is
 * always treated as an outage, never as an allow: `success: true` with no
 * usable `reset`/`remaining` tells us nothing, and trusting it would be
 * fail-open under a different name.
 */
export const DEFAULT_REDIS_OUTAGE_POLICY: RedisOutagePolicy = "fail-closed";

/**
 * How long a caller is kept away when we cannot count them at all. One window
 * would be a guess about a clock we cannot see and one second would be a retry
 * storm against a dependency that is expected to come back on its own.
 */
export const REDIS_OUTAGE_RETRY_AFTER_SECONDS = 30;

/**
 * Upper bound on waiting for Upstash before the answer is called an outage. The
 * library default (5 s) spends longer on the guard than a graded submission can
 * afford to wait, and the library *fail-opens* when it fires; the response is
 * re-treated as an outage here so `outagePolicy` stays the only say-so on
 * availability. `0` disables the race and leaves retries to the Redis client.
 */
export const DEFAULT_REDIS_TIMEOUT_MS = 2500;

/** Key namespace, so these counters sit apart from any other data in the same index. */
export const DEFAULT_REDIS_PREFIX = "proofofskill:ratelimit";

/**
 * The subset of Upstash's response this module reads. Declared here rather than
 * imported because `@upstash/ratelimit` does not export `RatelimitResponse`, and
 * because it doubles as the dependency-injection seam: a test can hand the
 * factory a stub with this shape and exercise all of the arithmetic below
 * without a network.
 */
export type UpstashLimitResponse = {
  success: boolean;
  remaining: number;
  /** Absolute unix ms. */
  reset: number;
  limit?: number;
  /** Cross-region/analytics work the library still owes after returning. */
  pending?: Promise<unknown>;
  reason?: "timeout" | "cacheBlock" | "denyList";
};

/** Anything shaped like `Ratelimit` — which the real class satisfies structurally. */
export type UpstashLimitClient = {
  limit(identifier: string): Promise<UpstashLimitResponse>;
};

export type UpstashConfig = { url: string; token: string };

/** Exported because it appears in `parseUpstashConfig`'s signature; mirrors `lib/env.server.ts`. */
export type EnvSource = Readonly<Record<string, string | undefined>>;

export type UpstashConfigResult =
  | { ok: true; config: UpstashConfig }
  /** `problem` names the key and never its value, so it is safe to log. */
  | { ok: false; problem: string };

const HTTP_URL_SHAPE = /^https?:\/\/\S+$/;

/**
 * Reads the Upstash pair from a caller-supplied environment. Optional in a way
 * `ATTESTATION_SECRET` is not: a missing pair is a valid, if weaker,
 * configuration, so this reports a reason instead of failing the whole env, and
 * `parseEnv()` in `lib/env.server.ts` stays the validator for everything that
 * has no working fallback. Note the default argument reads `process.env` at
 * *call* time, never at import time, so `next build` with an empty `.env.local`
 * still succeeds.
 */
export function parseUpstashConfig(source: EnvSource = process.env): UpstashConfigResult {
  return normalizeUpstashConfig({
    url: source.UPSTASH_REDIS_REST_URL ?? "",
    token: source.UPSTASH_REDIS_REST_TOKEN ?? "",
  });
}

/**
 * Both or neither. A url without a token (or whitespace that trims away to
 * nothing) would build a client that throws its own error on the first call,
 * several seconds into a request — so it is rejected here and the caller falls
 * back with a reason instead.
 */
function normalizeUpstashConfig(raw: UpstashConfig): UpstashConfigResult {
  const url = raw.url.trim();
  const token = raw.token.trim();

  if (url === "" && token === "") {
    return {
      ok: false,
      problem: "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are not set",
    };
  }
  if (url === "") {
    return { ok: false, problem: "UPSTASH_REDIS_REST_URL is not set" };
  }
  if (token === "") {
    return { ok: false, problem: "UPSTASH_REDIS_REST_TOKEN is not set" };
  }
  if (!HTTP_URL_SHAPE.test(url)) {
    return { ok: false, problem: "UPSTASH_REDIS_REST_URL is not an http(s) URL" };
  }
  return { ok: true, config: { url, token } };
}

const DURATION_UNITS: readonly [number, string][] = [
  [604_800_000, "w"],
  [86_400_000, "d"],
  [3_600_000, "h"],
  [60_000, "m"],
  [1_000, "s"],
  [1, "ms"],
];

/**
 * `windowMs` in the shape `@upstash/ratelimit` accepts (`"10 m"`): its parser is
 * `/^(\d+(?:\.\d+)?)\s?(ms|s|m|h|d|w)$/`, so a bare number or a negative value
 * throws at construction. Largest whole unit first keeps the Redis key prefix
 * and the dashboard readable; anything that divides into no unit falls to `ms`.
 */
export function upstashWindow(windowMs: number): Duration {
  const whole = Number.isFinite(windowMs) ? Math.max(1, Math.floor(windowMs)) : 1;
  for (const [unitMs, suffix] of DURATION_UNITS) {
    if (whole >= unitMs && whole % unitMs === 0) {
      return `${whole / unitMs} ${suffix}` as Duration;
    }
  }
  return `${whole} ms`;
}

/**
 * Turns Upstash's absolute `reset` into a header-safe wait.
 *
 * Three rules, all of them about the header being believed:
 * - never below 1 — a decline with `retry-after: 0` invites a tight loop, and
 *   a `reset` in the past means the window already rolled over, so 1 s is the
 *   honest answer rather than 0 or a negative number;
 * - never above one full window — a skewed clock or a bogus `reset` must not be
 *   able to lock a client out for a year through a header we generated;
 * - always an integer, because `Retry-After` is an integer number of seconds.
 */
export function retryAfterSecondsFrom(resetMs: number, nowMs: number, windowMs: number): number {
  const deltaMs = resetMs - nowMs;
  if (!Number.isFinite(deltaMs)) {
    return windowSeconds(windowMs);
  }
  return clampSeconds(Math.ceil(deltaMs / 1000), windowMs);
}

/** The most wait we will ever advertise: one full window, in whole seconds. */
function windowSeconds(windowMs: number): number {
  return Math.max(1, Math.ceil(windowMs / 1000));
}

/** Same rules as above, applied to a wait that is already in seconds. */
function clampSeconds(seconds: number, windowMs: number): number {
  if (!Number.isFinite(seconds)) {
    return windowSeconds(windowMs);
  }
  return Math.min(windowSeconds(windowMs), Math.max(1, Math.trunc(seconds)));
}

/** `Retry-After` for a limiter we could not consult; bounded by the same rules as above. */
function outageRetryAfterSeconds(windowMs: number): number {
  return clampSeconds(REDIS_OUTAGE_RETRY_AFTER_SECONDS, windowMs);
}

export type RateLimiterOptions = {
  /** Window length, shared by both backends so a fallback is not a quiet loosening. */
  windowMs?: number;
  maxRequests?: number;
  /**
   * Supplies the distributed backend. A function is resolved on the first
   * `check()` and memoised, which is what lets a route keep its module-level
   * `const limiter = …` while `next build` — which evaluates that module with an
   * empty environment — does not freeze the choice.
   */
  upstash?: UpstashConfig | null | (() => UpstashConfig | null);
  /** Test seam: replaces the whole client. Implies the distributed backend. */
  client?: UpstashLimitClient;
  outagePolicy?: RedisOutagePolicy;
  /** ms before Upstash is called unreachable; `0` disables the timeout. */
  timeoutMs?: number;
  prefix?: string;
};

/**
 * What a route gets back. Shaped so the existing call site keeps working:
 * `if (!limit.ok)` plus `limit.retryAfterSeconds`, now with a `decline` that
 * separates "this client is over budget" from "we could not count", and a
 * `cause` to log.
 */
export type RateLimitDecision =
  | {
      readonly ok: true;
      readonly backend: RateLimitBackend;
      readonly remaining: number;
      readonly retryAfterSeconds: 0;
      readonly decline: null;
      /** Non-null only under a fail-open policy: what we could not reach. */
      readonly cause: string | null;
    }
  | {
      readonly ok: false;
      readonly backend: RateLimitBackend;
      readonly remaining: 0;
      readonly retryAfterSeconds: number;
      readonly decline: RateLimitDecline;
      readonly cause: string | null;
    };

export type RateLimiterHandle = {
  /** Forces the one-time backend choice, so reading it is also a liveness probe. */
  readonly backend: RateLimitBackend;
  readonly outagePolicy: RedisOutagePolicy;
  /** Which backend was chosen and why — for a startup log line or a health route. */
  describe(): string;
  check(key: string, nowMs?: number): Promise<RateLimitDecision>;
};

type Resolution = {
  backend: RateLimitBackend;
  client: UpstashLimitClient | null;
  /** Why the distributed backend was not chosen; `null` when it was. */
  problem: string | null;
};

function textOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The library hands back `pending` for work it chose not to wait for (region
 * sync, analytics). Nothing here awaits it — the decision is already made — so
 * it gets a sink, or a late rejection becomes an unhandled rejection and can
 * take the process down over a bookkeeping write.
 */
function swallow(pending: Promise<unknown> | undefined): void {
  if (pending) {
    pending.catch(() => {});
  }
}

/**
 * The factory a route calls. Distributed when a usable Upstash config (or an
 * injected client) is present, otherwise the original in-process fixed window —
 * and it always says which one it picked, because a limiter that silently
 * degraded is a limiter that silently stopped protecting the bill.
 */
export function createRateLimiterWithFallback(options: RateLimiterOptions = {}): RateLimiterHandle {
  const windowMs = options.windowMs ?? WINDOW_MS;
  const maxRequests = options.maxRequests ?? MAX_REQUESTS;
  const outagePolicy = options.outagePolicy ?? DEFAULT_REDIS_OUTAGE_POLICY;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REDIS_TIMEOUT_MS;
  const prefix = options.prefix ?? DEFAULT_REDIS_PREFIX;

  /** Created once and reused: a fresh fallback per call would reset its own counts. */
  let fallback: RateLimiter | null = null;
  let resolution: Resolution | null = null;

  function local(): RateLimiter {
    fallback ??= createRateLimiter({ windowMs, maxRequests });
    return fallback;
  }

  function buildDistributed(config: UpstashConfig): Resolution {
    try {
      // `Ratelimit`'s built-in timeout fail-opens with `reason: "timeout"`; the
      // check below re-decides that under `outagePolicy`, so the library bounds
      // the wait and this module owns the consequence.
      const client: UpstashLimitClient = new Ratelimit({
        // One retry, not the client's default five: attempts that outlive our
        // deadline still cost Upstash requests, and by then the caller has
        // already been answered. The retry exists to cover a single transient
        // reset inside `timeoutMs`, nothing more.
        redis: new Redis({ url: config.url, token: config.token, retry: { retries: 1 } }),
        limiter: Ratelimit.slidingWindow(maxRequests, upstashWindow(windowMs)),
        prefix,
        timeout: timeoutMs,
      });
      return { backend: "distributed", client, problem: null };
    } catch (error) {
      // Construction is the last place a bad config can still surface; degrading
      // here beats throwing at the first user request.
      return { backend: "in-process", client: null, problem: `Upstash client could not be built: ${textOf(error)}` };
    }
  }

  function resolve(): Resolution {
    if (resolution) {
      return resolution;
    }
    if (options.client) {
      resolution = { backend: "distributed", client: options.client, problem: null };
      return resolution;
    }
    const supplied = typeof options.upstash === "function" ? options.upstash() : (options.upstash ?? null);
    if (supplied === null) {
      resolution = {
        backend: "in-process",
        client: null,
        problem: "no Upstash config passed to createRateLimiterWithFallback",
      };
      return resolution;
    }
    const normalized = normalizeUpstashConfig(supplied);
    resolution = normalized.ok
      ? buildDistributed(normalized.config)
      : { backend: "in-process", client: null, problem: normalized.problem };
    return resolution;
  }

  function declined(reason: RateLimitDecline, waitSeconds: number, cause: string | null): RateLimitDecision {
    return {
      ok: false,
      backend: "distributed",
      remaining: 0,
      retryAfterSeconds: waitSeconds,
      decline: reason,
      cause,
    };
  }

  /**
   * The single place the outage policy is applied. `backend` stays
   * `"distributed"` even on an outage: it reports what was configured, while
   * `decline`/`cause` report what actually happened, so a log can tell "Redis is
   * down" from "this address is over budget".
   */
  function outage(cause: string): RateLimitDecision {
    if (outagePolicy === "fail-closed") {
      return declined("redis-outage", outageRetryAfterSeconds(windowMs), cause);
    }
    return {
      ok: true,
      backend: "distributed",
      // Unknown: nothing was counted, so claiming the budget still has room
      // would be invented. `cause` is the signal here, not this number.
      remaining: 0,
      retryAfterSeconds: 0,
      decline: null,
      cause,
    };
  }

  async function checkDistributed(client: UpstashLimitClient, key: string, nowMs: number): Promise<RateLimitDecision> {
    let response: UpstashLimitResponse;
    try {
      response = await client.limit(key);
    } catch (error) {
      return outage(`Upstash limit check failed: ${textOf(error)}`);
    }
    swallow(response.pending);

    if (response.reason === "timeout") {
      return outage(`Upstash did not answer within ${timeoutMs} ms`);
    }
    if (response.reason === "denyList") {
      // A deny-list match is a decision Redis actually made, so it is a decline
      // and not an outage — but its `reset` is 0, so it must be labelled before
      // the reset guard below, which would otherwise read it as a broken reply.
      // Unreachable today: `enableProtection` is never turned on here.
      return declined("limit-exceeded", outageRetryAfterSeconds(windowMs), "Upstash deny list matched");
    }
    if (!Number.isFinite(response.reset) || response.reset <= 0) {
      return outage("Upstash returned no usable reset timestamp");
    }

    // `cacheBlock` is the library short-circuiting a client it already blocked,
    // which is the same outcome as asking Redis and being told no.
    if (!response.success) {
      return declined(
        "limit-exceeded",
        retryAfterSecondsFrom(response.reset, nowMs, windowMs),
        null,
      );
    }
    return {
      ok: true,
      backend: "distributed",
      remaining: Math.min(maxRequests, Math.max(0, Math.trunc(response.remaining))),
      retryAfterSeconds: 0,
      decline: null,
      cause: null,
    };
  }

  function fromLocal(result: RateLimitResult): RateLimitDecision {
    if (!result.ok) {
      // The in-process limiter already returns a bounded, integer wait; this
      // only re-clamps it so both backends make the same promise to the client.
      return {
        ok: false,
        backend: "in-process",
        remaining: 0,
        retryAfterSeconds: clampSeconds(result.retryAfterSeconds, windowMs),
        decline: "limit-exceeded",
        cause: null,
      };
    }
    return {
      ok: true,
      backend: "in-process",
      remaining: Math.min(maxRequests, Math.max(0, result.remaining)),
      retryAfterSeconds: 0,
      decline: null,
      cause: null,
    };
  }

  return {
    get backend(): RateLimitBackend {
      return resolve().backend;
    },
    outagePolicy,
    describe(): string {
      const current = resolve();
      const budget = `${maxRequests} per ${upstashWindow(windowMs)}`;
      if (current.backend === "distributed") {
        return `distributed sliding window (${budget}, outage policy=${outagePolicy}, timeout=${timeoutMs} ms, prefix=${prefix})`;
      }
      return `in-process fixed window fallback (${budget}, policy=${outagePolicy} unused): ${current.problem ?? "no distributed backend"}`;
    },
    async check(key: string, nowMs: number = Date.now()): Promise<RateLimitDecision> {
      const current = resolve();
      if (current.backend === "distributed" && current.client) {
        return checkDistributed(current.client, key, nowMs);
      }
      return fromLocal(local().check(key, nowMs));
    },
  };
}

