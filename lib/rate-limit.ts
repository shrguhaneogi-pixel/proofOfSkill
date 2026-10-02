/**
 * In-memory fixed-window rate limiter.
 *
 * Deliberately MVP-grade and documented as such: state lives in this process, so
 * it resets on restart and is per-instance behind a multi-instance deploy. It
 * exists to stop an accidental or casual flood from spending evaluator credits,
 * not to be a distributed firewall.
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
