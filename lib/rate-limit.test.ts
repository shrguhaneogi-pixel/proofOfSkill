import { describe, expect, it, vi } from "vitest";

// `server-only` resolves to a throwing stub outside a React Server bundler, so
// it is stubbed here; production still gets the real guard.
vi.mock("server-only", () => ({ default: {} }));

import { clientKey, createRateLimiter } from "./rate-limit";

const BASE = 1_700_000_000_000;

function headers(value: string | null): Headers {
  const headers = new Headers();
  if (value !== null) {
    headers.set("x-forwarded-for", value);
  }
  return headers;
}

describe("createRateLimiter", () => {
  it("allows requests up to the limit inside one window", () => {
    const limiter = createRateLimiter({ windowMs: 1000, maxRequests: 3 });
    expect(limiter.check("a", BASE).ok).toBe(true);
    expect(limiter.check("a", BASE + 100).ok).toBe(true);
    expect(limiter.check("a", BASE + 200).ok).toBe(true);
    expect(limiter.check("a", BASE + 300).ok).toBe(false);
  });

  it("reports a decreasing remaining count", () => {
    const limiter = createRateLimiter({ windowMs: 1000, maxRequests: 2 });
    expect(limiter.check("a", BASE).remaining).toBe(1);
    expect(limiter.check("a", BASE + 1).remaining).toBe(0);
    expect(limiter.check("a", BASE + 2).remaining).toBe(0);
  });

  it("never reports a zero retry-after when it says no", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 1 });
    limiter.check("a", BASE);
    const blocked = limiter.check("a", BASE + 1_000);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("opens a fresh window once the old one elapses", () => {
    const limiter = createRateLimiter({ windowMs: 1000, maxRequests: 1 });
    limiter.check("a", BASE);
    expect(limiter.check("a", BASE + 999).ok).toBe(false);
    expect(limiter.check("a", BASE + 1000).ok).toBe(true);
  });

  it("keeps separate keys in separate buckets", () => {
    const limiter = createRateLimiter({ windowMs: 1000, maxRequests: 1 });
    expect(limiter.check("a", BASE).ok).toBe(true);
    expect(limiter.check("b", BASE).ok).toBe(true);
    expect(limiter.check("a", BASE + 1).ok).toBe(false);
  });

  it("evicts buckets that have been idle past the sweep horizon", () => {
    const limiter = createRateLimiter({ windowMs: 1000, maxRequests: 5 });
    limiter.check("a", BASE);
    limiter.check("b", BASE);
    expect(limiter.size(BASE)).toBe(2);
    // One hour later both windows are long expired.
    expect(limiter.size(BASE + 60 * 60 * 1000 * 2)).toBe(0);
  });
});

describe("clientKey", () => {
  it("uses the first forwarded hop", () => {
    expect(clientKey(headers("203.0.113.7, 70.41.3.18"))).toBe("203.0.113.7");
  });

  it("trims whitespace around the hop", () => {
    expect(clientKey(headers("  203.0.113.9  "))).toBe("203.0.113.9");
  });

  it("falls back to a shared bucket instead of failing open per client", () => {
    expect(clientKey(headers(null))).toBe("shared");
    expect(clientKey(headers(" , "))).toBe("shared");
  });
});
