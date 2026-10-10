import { describe, expect, it, vi } from "vitest";

// `server-only` resolves to a throwing stub outside a React Server bundler, so
// it is stubbed here; production still gets the real guard.
vi.mock("server-only", () => ({ default: {} }));

import {
  DEFAULT_REDIS_OUTAGE_POLICY,
  REDIS_OUTAGE_RETRY_AFTER_SECONDS,
  createRateLimiterWithFallback,
  parseUpstashConfig,
  retryAfterSecondsFrom,
  upstashWindow,
  type UpstashLimitClient,
  type UpstashLimitResponse,
} from "./rate-limit";

/** A plausible unix ms, so `reset - now` arithmetic behaves like production. */
const BASE = 1_700_000_000_000;
const WINDOW = 10 * 60 * 1000;
const MAX = 8;
const CONFIG = { url: "https://example-upstash-rest.invalid", token: "not-a-real-token" };

function response(overrides: Partial<UpstashLimitResponse>): UpstashLimitResponse {
  return { success: true, limit: MAX, remaining: MAX - 1, reset: BASE + WINDOW, ...overrides };
}

/**
 * Stands in for `Ratelimit` at the `limit()` seam: no Redis, no network, and the
 * exact `{ remaining, reset }` pair the arithmetic has to survive. The recorded
 * `calls` ride on the client itself so a test cannot accidentally pass the
 * wrapper where a client belongs.
 */
function stubClient(
  responder: (identifier: string, callIndex: number) => UpstashLimitResponse | Error,
): UpstashLimitClient & { calls: string[] } {
  const calls: string[] = [];
  return Object.assign(
    {
      async limit(identifier: string): Promise<UpstashLimitResponse> {
        const index = calls.length;
        calls.push(identifier);
        const outcome = responder(identifier, index);
        if (outcome instanceof Error) {
          throw outcome;
        }
        return outcome;
      },
    } satisfies UpstashLimitClient,
    { calls },
  );
}

/** Tracks the process-level consequence the module is supposed to prevent. */
function trackUnhandledRejections(): { seen: unknown[]; stop: () => void } {
  const seen: unknown[] = [];
  const handler = (reason: unknown) => seen.push(reason);
  process.on("unhandledRejection", handler);
  return { seen, stop: () => process.off("unhandledRejection", handler) };
}

describe("upstashWindow", () => {
  it("picks the largest whole unit Upstash's parser will accept", () => {
    expect(upstashWindow(WINDOW)).toBe("10 m");
    expect(upstashWindow(90_000)).toBe("90 s");
    expect(upstashWindow(4 * 60 * 60 * 1000)).toBe("4 h");
    expect(upstashWindow(24 * 60 * 60 * 1000)).toBe("1 d");
    expect(upstashWindow(7 * 24 * 60 * 60 * 1000)).toBe("1 w");
  });

  it("falls back to ms for a window that divides into no larger unit", () => {
    expect(upstashWindow(1_500)).toBe("1500 ms");
    // 700 s divides by 1000 but not by 60_000.
    expect(upstashWindow(700_000)).toBe("700 s");
  });

  it("always emits a string the library's duration regex parses", () => {
    // Copied from @upstash/ratelimit's own parser: anything else throws at
    // construction, several seconds before the first user request would notice.
    const libraryParser = /^(\d+(?:\.\d+)?)\s?(ms|s|m|h|d|w)$/;
    for (const ms of [1, 999, 1000, 60_000, WINDOW, 700_000, 3_600_000, 86_400_000, 604_800_000]) {
      expect(upstashWindow(ms)).toMatch(libraryParser);
    }
  });

  it("refuses to emit a zero-length or unparseable window", () => {
    const libraryParser = /^(\d+(?:\.\d+)?)\s?(ms|s|m|h|d|w)$/;
    for (const bad of [0, -5_000, Number.NaN, Number.POSITIVE_INFINITY, 0.4]) {
      expect(upstashWindow(bad)).toMatch(libraryParser);
    }
  });
});

describe("retryAfterSecondsFrom", () => {
  it("converts the absolute reset into a whole-second wait", () => {
    expect(retryAfterSecondsFrom(BASE + 45_000, BASE, WINDOW)).toBe(45);
    expect(retryAfterSecondsFrom(BASE + 44_000, BASE, WINDOW)).toBe(44);
    // Partial seconds round up: a truncated value would invite an early retry.
    expect(retryAfterSecondsFrom(BASE + 44_001, BASE, WINDOW)).toBe(45);
  });

  it("never goes to zero or negative when the reset is in the past", () => {
    expect(retryAfterSecondsFrom(BASE, BASE, WINDOW)).toBe(1);
    expect(retryAfterSecondsFrom(BASE - 1, BASE, WINDOW)).toBe(1);
    expect(retryAfterSecondsFrom(BASE - 600_000, BASE, WINDOW)).toBe(1);
  });

  it("never advertises more than one full window, whatever the clock says", () => {
    const tenYearsMs = 10 * 365 * 24 * 60 * 60 * 1000;
    expect(retryAfterSecondsFrom(BASE + tenYearsMs, BASE, WINDOW)).toBe(600);
    expect(retryAfterSecondsFrom(Number.NaN, BASE, WINDOW)).toBe(600);
    expect(retryAfterSecondsFrom(Number.POSITIVE_INFINITY, BASE, WINDOW)).toBe(600);
  });

  it("produces an integer", () => {
    for (const delta of [-1, 0, 1, 999, 1000, 1001, WINDOW, WINDOW * 5]) {
      expect(Number.isInteger(retryAfterSecondsFrom(BASE + delta, BASE, WINDOW))).toBe(true);
    }
  });
});

describe("createRateLimiterWithFallback backend selection", () => {
  it("uses the distributed backend when a usable config is supplied", () => {
    // Construction must not touch the network: this is the no-Redis-host case.
    const limiter = createRateLimiterWithFallback({ windowMs: WINDOW, maxRequests: MAX, upstash: CONFIG });
    expect(limiter.backend).toBe("distributed");
    expect(limiter.describe()).toContain("distributed sliding window");
    expect(limiter.describe()).toContain("8 per 10 m");
    expect(limiter.describe()).toContain("policy=fail-closed");
  });

  it("never puts a credential in the diagnostic string", () => {
    const limiter = createRateLimiterWithFallback({ upstash: CONFIG });
    expect(limiter.describe()).not.toContain(CONFIG.token);
    expect(limiter.describe()).not.toContain(CONFIG.url);
  });

  it("uses the distributed backend for an injected client", async () => {
    const client = stubClient(() => response({}));
    const limiter = createRateLimiterWithFallback({ client });
    expect(limiter.backend).toBe("distributed");
    expect((await limiter.check("203.0.113.7", BASE)).ok).toBe(true);
  });

  it("falls back to in-process when there is no config at all", () => {
    const limiter = createRateLimiterWithFallback({ windowMs: WINDOW, maxRequests: MAX });
    expect(limiter.backend).toBe("in-process");
    expect(limiter.describe()).toContain("in-process fixed window fallback");
    expect(limiter.describe()).toContain("no Upstash config");
  });

  it("falls back when only half the pair is configured, and says which key", () => {
    const missingToken = createRateLimiterWithFallback({ upstash: { url: CONFIG.url, token: "  " } });
    expect(missingToken.backend).toBe("in-process");
    expect(missingToken.describe()).toContain("UPSTASH_REDIS_REST_TOKEN is not set");

    const missingUrl = createRateLimiterWithFallback({ upstash: { url: "", token: "t" } });
    expect(missingUrl.describe()).toContain("UPSTASH_REDIS_REST_URL is not set");
  });

  it("falls back on a malformed url rather than building a doomed client", () => {
    const limiter = createRateLimiterWithFallback({ upstash: { url: "redis://127.0.0.1", token: "t" } });
    expect(limiter.backend).toBe("in-process");
    expect(limiter.describe()).toContain("not an http(s) URL");
  });

  it("resolves a config thunk once, on first use, not at import time", async () => {
    const read = vi.fn(() => null);
    const limiter = createRateLimiterWithFallback({ upstash: read });
    // Merely constructing must not decide anything: `next build` evaluates route
    // modules with an empty environment.
    expect(read).not.toHaveBeenCalled();

    await limiter.check("a", BASE);
    await limiter.check("a", BASE);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("keeps the in-process budget identical to the configured one", async () => {
    const limiter = createRateLimiterWithFallback({ windowMs: 1000, maxRequests: 2 });
    expect((await limiter.check("a", BASE)).ok).toBe(true);
    expect((await limiter.check("a", BASE + 10)).ok).toBe(true);
    const third = await limiter.check("a", BASE + 20);
    expect(third.ok).toBe(false);
    expect(third.backend).toBe("in-process");
    expect(third.decline).toBe("limit-exceeded");
  });
});

describe("parseUpstashConfig", () => {
  it("accepts a filled-in source and trims it", () => {
    const result = parseUpstashConfig({
      UPSTASH_REDIS_REST_URL: ` ${CONFIG.url} `,
      UPSTASH_REDIS_REST_TOKEN: " t ",
    });
    expect(result).toEqual({ ok: true, config: { url: CONFIG.url, token: "t" } });
  });

  it("treats a blank value as unset rather than as configured-empty", () => {
    const result = parseUpstashConfig({ UPSTASH_REDIS_REST_URL: "   ", UPSTASH_REDIS_REST_TOKEN: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem).toContain("UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are not set");
      expect(result.problem).not.toContain(CONFIG.token);
    }
  });

  it("names the key it is missing and never a value", () => {
    const result = parseUpstashConfig({ UPSTASH_REDIS_REST_URL: CONFIG.url, UPSTASH_REDIS_REST_TOKEN: undefined });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem).toBe("UPSTASH_REDIS_REST_TOKEN is not set");
    }
  });
});

describe("distributed sliding-window arithmetic", () => {
  it("turns a stubbed block into the right wait", async () => {
    const client = stubClient(() => response({ success: false, remaining: 0, reset: BASE + 45_000 }));
    const limiter = createRateLimiterWithFallback({ windowMs: WINDOW, maxRequests: MAX, client });

    const blocked = await limiter.check("203.0.113.7", BASE);
    expect(client.calls).toEqual(["203.0.113.7"]);
    expect(blocked).toMatchObject({
      ok: false,
      backend: "distributed",
      remaining: 0,
      retryAfterSeconds: 45,
      decline: "limit-exceeded",
      cause: null,
    });
  });

  it("clamps a future reset and floors a past one, and both are header-safe", async () => {
    const script = (reset: number) =>
      createRateLimiterWithFallback({
        windowMs: WINDOW,
        maxRequests: MAX,
        client: stubClient(() => response({ success: false, remaining: 0, reset })),
      });

    const far = await script(BASE + 50 * WINDOW).check("a", BASE);
    const past = await script(BASE - WINDOW).check("a", BASE);
    expect(far.retryAfterSeconds).toBe(600);
    expect(past.retryAfterSeconds).toBe(1);

    for (const decision of [far, past]) {
      expect(Number.isInteger(decision.retryAfterSeconds)).toBe(true);
      expect(decision.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      // The route's exact header expression has to survive it.
      const headers = new Headers({ "retry-after": String(decision.retryAfterSeconds) });
      expect(headers.get("retry-after")).toBe(String(decision.retryAfterSeconds));
    }
  });

  it("reports remaining from Redis, clamped into the configured budget", async () => {
    const ok = createRateLimiterWithFallback({ windowMs: WINDOW, maxRequests: MAX, client: stubClient(() => response({ remaining: 3 })) });
    expect((await ok.check("a", BASE)).remaining).toBe(3);

    const negative = createRateLimiterWithFallback({ maxRequests: MAX, client: stubClient(() => response({ remaining: -7 })) });
    expect((await negative.check("a", BASE)).remaining).toBe(0);

    const inflated = createRateLimiterWithFallback({ maxRequests: MAX, client: stubClient(() => response({ remaining: 999 })) });
    expect((await inflated.check("a", BASE)).remaining).toBe(MAX);
  });

  it("treats the library's local cache block as an ordinary decline", async () => {
    const limiter = createRateLimiterWithFallback({
      windowMs: WINDOW,
      maxRequests: MAX,
      client: stubClient(() => response({ success: false, remaining: 0, reset: BASE + 20_000, reason: "cacheBlock" })),
    });
    const decision = await limiter.check("a", BASE);
    expect(decision).toMatchObject({ ok: false, decline: "limit-exceeded", retryAfterSeconds: 20 });
  });

  it("keeps each key in its own window", async () => {
    // A per-identifier counter, which is what Redis itself is: the module must
    // pass the caller's key straight through as the identifier.
    const used = new Map<string, number>();
    const client = stubClient((identifier) => {
      const count = (used.get(identifier) ?? 0) + 1;
      used.set(identifier, count);
      return count <= 2
        ? response({ remaining: MAX - count })
        : response({ success: false, remaining: 0, reset: BASE + 30_000 });
    });
    const limiter = createRateLimiterWithFallback({ windowMs: WINDOW, maxRequests: MAX, client });

    expect((await limiter.check("a", BASE)).ok).toBe(true);
    expect((await limiter.check("a", BASE)).ok).toBe(true);
    const exhausted = await limiter.check("a", BASE);
    expect(exhausted.ok).toBe(false);
    // A different address is untouched by a's overrun.
    expect((await limiter.check("b", BASE)).ok).toBe(true);
    expect(client.calls).toEqual(["a", "a", "a", "b"]);
  });

  it("swallows the library's abandoned pending work instead of crashing on it", async () => {
    const tracker = trackUnhandledRejections();
    try {
      const limiter = createRateLimiterWithFallback({
        client: stubClient(() => response({ pending: Promise.reject(new Error("region sync failed")) })),
      });
      expect((await limiter.check("a", BASE)).ok).toBe(true);
      // A rejection is only reported as unhandled once the tick drains, so wait
      // for a macrotask rather than a couple of microtasks.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(tracker.seen).toEqual([]);
    } finally {
      tracker.stop();
    }
  });
});

describe("Redis outage policy", () => {
  it("documents the choice: a paid endpoint fails closed", () => {
    expect(DEFAULT_REDIS_OUTAGE_POLICY).toBe("fail-closed");
  });

  it("declines when the client rejects, under the default policy", async () => {
    const limiter = createRateLimiterWithFallback({
      windowMs: WINDOW,
      maxRequests: MAX,
      client: stubClient(() => new Error("connect ECONNREFUSED 127.0.0.1:6379")),
    });
    const decision = await limiter.check("a", BASE);
    expect(decision).toMatchObject({
      ok: false,
      backend: "distributed",
      decline: "redis-outage",
      retryAfterSeconds: REDIS_OUTAGE_RETRY_AFTER_SECONDS,
    });
    expect(decision.cause).toContain("connect ECONNREFUSED");
  });

  it("keeps a non-Error throw diagnosable", async () => {
    const limiter = createRateLimiterWithFallback({ client: stubClient(() => {
      throw "redis is down";
    }) });
    const decision = await limiter.check("a", BASE);
    expect(decision.decline).toBe("redis-outage");
    expect(decision.cause).toContain("redis is down");
  });

  it("allows when the policy is fail-open, but still says why", async () => {
    const limiter = createRateLimiterWithFallback({
      windowMs: WINDOW,
      maxRequests: MAX,
      outagePolicy: "fail-open",
      client: stubClient(() => new Error("ETIMEDOUT")),
    });
    const decision = await limiter.check("a", BASE);
    expect(decision).toMatchObject({
      ok: true,
      backend: "distributed",
      decline: null,
      retryAfterSeconds: 0,
      remaining: 0,
    });
    expect(decision.cause).toContain("ETIMEDOUT");
  });

  it("overrides the library's own fail-open on a timeout", async () => {
    // Upstash returns `success: true, reset: 0, reason: "timeout"` once its
    // internal deadline passes. Under fail-closed that must not become an allow.
    const timedOut = () =>
      response({ success: true, remaining: 0, reset: 0, reason: "timeout" });

    const closed = await createRateLimiterWithFallback({
      windowMs: WINDOW,
      maxRequests: MAX,
      client: stubClient(timedOut),
    }).check("a", BASE);
    expect(closed).toMatchObject({ ok: false, decline: "redis-outage" });

    const open = await createRateLimiterWithFallback({
      windowMs: WINDOW,
      maxRequests: MAX,
      outagePolicy: "fail-open",
      client: stubClient(timedOut),
    }).check("a", BASE);
    expect(open).toMatchObject({ ok: true });
    expect(open.cause).toContain("did not answer within");
  });

  it("treats a malformed allow as an outage, never as a free pass", async () => {
    for (const reset of [0, -1, Number.NaN]) {
      const decision = await createRateLimiterWithFallback({
        windowMs: WINDOW,
        maxRequests: MAX,
        client: stubClient(() => response({ remaining: 5, reset })),
      }).check("a", BASE);
      expect(decision.ok).toBe(false);
      expect(decision.decline).toBe("redis-outage");
      expect(decision.cause).toContain("reset");
    }
  });

  it("bounds the outage wait by the window, for a short window", async () => {
    const decision = await createRateLimiterWithFallback({
      windowMs: 10_000,
      maxRequests: 2,
      client: stubClient(() => new Error("boom")),
    }).check("a", BASE);
    expect(decision.retryAfterSeconds).toBe(10);
  });
});

describe("real Upstash client wiring", () => {
  it("hands the key to the library and fails closed when it never answers", async () => {
    // No Redis host and no network: the REST call is stubbed to never settle, so
    // this still exercises the genuine construction path — `Redis`, the parsed
    // `"10 m"` window, `slidingWindow`'s script call — and lets the library's own
    // deadline produce the outage rather than a stub asserting it.
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const limiter = createRateLimiterWithFallback({
        upstash: CONFIG,
        windowMs: WINDOW,
        maxRequests: MAX,
        timeoutMs: 150,
      });
      expect(limiter.backend).toBe("distributed");

      const decision = await limiter.check("203.0.113.7", BASE);
      expect(fetchMock).toHaveBeenCalled();
      expect(decision).toMatchObject({
        ok: false,
        backend: "distributed",
        decline: "redis-outage",
        retryAfterSeconds: REDIS_OUTAGE_RETRY_AFTER_SECONDS,
      });
      expect(decision.cause).toContain("did not answer within 150 ms");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
