import { Connection, SolanaJSONRPCError, SolanaJSONRPCErrorCode, clusterApiUrl } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_COMMITMENT,
  DEFAULT_NETWORK,
  LOCALNET_RPC_URL,
  RpcHttpStatusError,
  RpcTimeoutError,
  classifyRpcFailure,
  clearConnectionCache,
  getConnection,
  isNetworkCluster,
  resolveBackupRpcUrl,
  resolveNetwork,
  resolveRpcEndpoints,
  resolveRpcUrl,
  withRpcRetry,
} from "./connection";

describe("resolveNetwork", () => {
  it("defaults to devnet when nothing is configured", () => {
    expect(resolveNetwork(undefined)).toBe(DEFAULT_NETWORK);
    expect(resolveNetwork("   ")).toBe("devnet");
    expect(DEFAULT_NETWORK).toBe("devnet");
  });

  it("accepts every documented cluster and normalizes case", () => {
    expect(resolveNetwork("devnet")).toBe("devnet");
    expect(resolveNetwork("MAINNET-BETA")).toBe("mainnet-beta");
    expect(resolveNetwork("localnet")).toBe("localnet");
  });

  it("refuses an unknown cluster instead of silently using devnet", () => {
    expect(() => resolveNetwork("devnet1")).toThrow(/NEXT_PUBLIC_SOLANA_NETWORK/);
  });
});

describe("isNetworkCluster", () => {
  it("recognizes only the supported names", () => {
    expect(isNetworkCluster("mainnet-beta")).toBe(true);
    expect(isNetworkCluster("mtn")).toBe(false);
  });
});

describe("resolveRpcUrl", () => {
  it("prefers an explicit endpoint and trims it", () => {
    expect(resolveRpcUrl("devnet", "  https://rpc.example.com  ")).toBe("https://rpc.example.com");
  });

  it("uses the library endpoint for a public cluster", () => {
    expect(resolveRpcUrl("devnet", "")).toBe(clusterApiUrl("devnet"));
    expect(resolveRpcUrl("mainnet-beta", undefined)).toBe(clusterApiUrl("mainnet-beta"));
  });

  it("maps localnet to the test validator port", () => {
    expect(resolveRpcUrl("localnet", "")).toBe(LOCALNET_RPC_URL);
    expect(LOCALNET_RPC_URL).toBe("http://127.0.0.1:8899");
  });

  it("falls back to devnet when no network is given", () => {
    expect(resolveRpcUrl(undefined, "")).toBe(clusterApiUrl("devnet"));
  });
});

describe("getConnection", () => {
  it("returns the same connection for the same endpoint and commitment", () => {
    const first = getConnection({ rpcUrl: LOCALNET_RPC_URL });
    const second = getConnection({ rpcUrl: LOCALNET_RPC_URL, commitment: DEFAULT_COMMITMENT });
    expect(second).toBe(first);
  });

  it("returns a different connection for a different commitment", () => {
    const confirmed = getConnection({ rpcUrl: LOCALNET_RPC_URL, commitment: "confirmed" });
    const finalized = getConnection({ rpcUrl: LOCALNET_RPC_URL, commitment: "finalized" });
    expect(finalized).not.toBe(confirmed);
  });
});

/* -------------------------------------------------------------------------- *
 * Resilience: the per-request deadline, the failure classes, and the retry budget.
 * -------------------------------------------------------------------------- */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  clearConnectionCache();
  delete process.env.SOLANA_RPC_URL_BACKUP;
  delete process.env.NEXT_PUBLIC_SOLANA_RPC_URL_BACKUP;
});

describe("getConnection deadline", () => {
  it("keys the cache on the deadline as well as the endpoint", () => {
    const slow = getConnection({ rpcUrl: LOCALNET_RPC_URL, timeoutMs: 60_000 });
    const fast = getConnection({ rpcUrl: LOCALNET_RPC_URL, timeoutMs: 1_000 });
    const alsoSlow = getConnection({ rpcUrl: LOCALNET_RPC_URL, timeoutMs: 60_000 });
    expect(slow).toBe(alsoSlow);
    expect(fast).not.toBe(slow);
    clearConnectionCache();
    expect(getConnection({ rpcUrl: LOCALNET_RPC_URL, timeoutMs: 60_000 })).not.toBe(slow);
  });

  it("aborts a request whose endpoint accepted the connection and then said nothing", async () => {
    // A fake that hangs unless the signal fires — what a stalled upstream does, and what undici
    // itself does. It proves the deadline is enforced by the caller rather than by the socket.
    vi.stubGlobal(
      "fetch",
      (_input: RequestInfo, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted", "AbortError")));
        }),
    );
    const connection = getConnection({ rpcUrl: LOCALNET_RPC_URL, timeoutMs: 20 });

    await expect(connection.getSlot()).rejects.toBeInstanceOf(RpcTimeoutError);
    const error = await catchRejection(() => connection.getSlot());
    expect(error).toBeInstanceOf(RpcTimeoutError);
    expect(classifyRpcFailure(error)).toEqual({ class: "timeout", retryable: true });
    // The message names no status and no provider body, so `lib/errors/signals.ts` files it as a
    // timeout rather than as something it cannot identify.
    expect((error as Error).message).toMatch(/timed out/);
  });

  it("still passes a healthy response through untouched", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse(4241));
    await expect(getConnection({ rpcUrl: LOCALNET_RPC_URL }).getSlot()).resolves.toBe(4241);
  });

  it("rejects a non-2xx with the status as a field, and owns the 429 retry itself", async () => {
    const fetchSpy = vi.fn(async () => new Response("<html>Too Many Requests</html>", { status: 429 }));
    vi.stubGlobal("fetch", fetchSpy);

    const error = await catchRejection(() => getConnection({ rpcUrl: LOCALNET_RPC_URL }).getSlot());
    expect(error).toBeInstanceOf(RpcHttpStatusError);
    expect((error as RpcHttpStatusError).status).toBe(429);
    // web3.js' built-in 429 loop (`disableRetryOnRateLimit`, off in `getConnection`) would have
    // made 5 requests and printed each one. One request means our budget is the only budget.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // The provider's body never reaches the error text.
    expect((error as Error).message).not.toContain("Too Many Requests");
    expect(classifyRpcFailure(error)).toEqual({ class: "rate-limit", retryable: true });
  });
});

describe("classifyRpcFailure", () => {
  it("names transport and timeout failures retryable", () => {
    expect(classifyRpcFailure(new Error("fetch failed"))).toEqual({ class: "transport", retryable: true });
    expect(classifyRpcFailure(new Error("connect ECONNREFUSED 127.0.0.1:8899"))).toEqual({
      class: "transport",
      retryable: true,
    });
    const cause = Object.assign(new Error("socket hang up"), {});
    expect(classifyRpcFailure(new Error("fetch failed", { cause }))).toEqual({ class: "transport", retryable: true });
    expect(classifyRpcFailure(new RpcTimeoutError(8_000, LOCALNET_RPC_URL))).toEqual({ class: "timeout", retryable: true });
    expect(classifyRpcFailure(Object.assign(new Error("upstream said nothing"), { name: "AbortError" }))).toEqual({
      class: "timeout",
      retryable: true,
    });
  });

  it("names 5xx retryable and 4xx not", () => {
    expect(classifyRpcFailure(Object.assign(new Error("bad gateway"), { status: 503 }))).toEqual({
      class: "server",
      retryable: true,
    });
    expect(classifyRpcFailure(new RpcHttpStatusError(401, "https://rpc.example.com"))).toEqual({
      class: "client",
      retryable: false,
    });
  });

  it("separates a node that is unhealthy from a node that answered", () => {
    expect(
      classifyRpcFailure(new SolanaJSONRPCError({ code: SolanaJSONRPCErrorCode.JSON_RPC_SERVER_ERROR_NODE_UNHEALTHY, message: "try later" })),
    ).toEqual({ class: "json-rpc-server", retryable: true });
    expect(
      classifyRpcFailure(new SolanaJSONRPCError({ code: SolanaJSONRPCErrorCode.JSON_RPC_SERVER_ERROR_BLOCK_NOT_AVAILABLE, message: "try later" })),
    ).toEqual({ class: "json-rpc-server", retryable: true });
    expect(
      classifyRpcFailure(
        new SolanaJSONRPCError({ code: SolanaJSONRPCErrorCode.JSON_RPC_SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, message: "simulation failed" }),
      ),
    ).toEqual({ class: "json-rpc", retryable: false });
    expect(
      classifyRpcFailure(new SolanaJSONRPCError({ code: SolanaJSONRPCErrorCode.JSON_RPC_SERVER_ERROR_BLOCK_CLEANED_UP, message: "gone" })),
    ).toEqual({ class: "json-rpc", retryable: false });
  });

  it("does not retry a failure it cannot name", () => {
    expect(classifyRpcFailure(new Error("something unexpected in the pipeline"))).toEqual({
      class: "unknown",
      retryable: false,
    });
    expect(classifyRpcFailure(undefined)).toEqual({ class: "unknown", retryable: false });
    expect(classifyRpcFailure("ECONNREFUSED")).toEqual({ class: "transport", retryable: true });
  });
});

describe("endpoint resolution", () => {
  it("uses no secondary when none is configured, and collapses one that equals the primary", () => {
    expect(resolveBackupRpcUrl(LOCALNET_RPC_URL, {})).toBeNull();
    expect(resolveBackupRpcUrl(LOCALNET_RPC_URL, { SOLANA_RPC_URL_BACKUP: "   " })).toBeNull();
    expect(resolveBackupRpcUrl(LOCALNET_RPC_URL, { SOLANA_RPC_URL_BACKUP: LOCALNET_RPC_URL })).toBeNull();
    expect(resolveBackupRpcUrl(LOCALNET_RPC_URL, { SOLANA_RPC_URL_BACKUP: "https://backup.example/rpc" })).toBe(
      "https://backup.example/rpc",
    );
    expect(resolveBackupRpcUrl(LOCALNET_RPC_URL, { NEXT_PUBLIC_SOLANA_RPC_URL_BACKUP: "https://b.example/rpc" })).toBe(
      "https://b.example/rpc",
    );
  });

  it("lists primary then backup, and only the primary for an explicit endpoint", () => {
    expect(resolveRpcEndpoints({ network: "localnet", rpcUrl: LOCALNET_RPC_URL })).toEqual([LOCALNET_RPC_URL]);
    process.env.SOLANA_RPC_URL_BACKUP = "https://backup.example/rpc";
    expect(resolveRpcEndpoints({ rpcUrl: LOCALNET_RPC_URL })).toEqual([LOCALNET_RPC_URL, "https://backup.example/rpc"]);
  });
});

describe("withRpcRetry", () => {
  const immediate = { jitter: false, baseDelayMs: 1, maxDelayMs: 10, sleep: async () => undefined } as const;
  const primary = new Connection("http://127.0.0.1:1", "confirmed");

  it("retries a retryable failure and rethrows the original error when the budget runs out", async () => {
    const original = new Error("connect ECONNREFUSED 127.0.0.1:8899");
    const attempts: string[] = [];
    const retries: number[] = [];

    await expect(
      withRpcRetry(
        async (_connection, endpoint) => {
          attempts.push(endpoint);
          throw original;
        },
        { ...immediate, maxAttempts: 3, connection: primary, onRetry: (info) => retries.push(info.attempt) },
      ),
    ).rejects.toBe(original);

    // Same endpoint three times: failover needs a second endpoint, not a wish.
    expect(attempts).toHaveLength(3);
    expect(new Set(attempts)).toEqual(new Set(["http://127.0.0.1:1"]));
    expect(retries).toEqual([1, 2]);
  });

  it("stops at the first success and reports the failed endpoint it moved away from", async () => {
    const flaky = new Error("fetch failed");
    let calls = 0;
    const seen: string[] = [];
    const retryInfo: { endpoint: string; failedEndpoint: string; failureClass: string; delayMs: number }[] = [];

    const result = await withRpcRetry(
      async (connection, endpoint) => {
        seen.push(endpoint);
        calls += 1;
        if (calls === 1) {
          throw flaky;
        }
        return connection.rpcEndpoint;
      },
      {
        ...immediate,
        baseDelayMs: 250,
        maxDelayMs: 10_000,
        endpoints: ["http://127.0.0.1:1", LOCALNET_RPC_URL],
        maxAttempts: 3,
        onRetry: (info) => retryInfo.push({ ...info }),
      },
    );

    expect(seen).toEqual(["http://127.0.0.1:1", LOCALNET_RPC_URL]);
    expect(result).toBe(LOCALNET_RPC_URL);
    expect(retryInfo).toHaveLength(1);
    expect(retryInfo[0]).toMatchObject({
      attempt: 1,
      failedEndpoint: "http://127.0.0.1:1",
      endpoint: LOCALNET_RPC_URL,
      failureClass: "transport",
      delayMs: 250,
    });
  });

  it("grows the delay exponentially and caps it", async () => {
    const delays: number[] = [];
    await expect(
      withRpcRetry(
        async () => {
          throw new Error("fetch failed");
        },
        { ...immediate, baseDelayMs: 100, maxDelayMs: 250, maxAttempts: 4, onRetry: (info) => delays.push(info.delayMs) },
      ),
    ).rejects.toThrow("fetch failed");
    expect(delays).toEqual([100, 200, 250]);
  });

  it("never retries a failure that is not retryable", async () => {
    const refusal = new SolanaJSONRPCError({ code: SolanaJSONRPCErrorCode.JSON_RPC_SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, message: "Simulation failed." });
    let calls = 0;
    await expect(
      withRpcRetry(
        async () => {
          calls += 1;
          throw refusal;
        },
        { ...immediate, connection: primary, maxAttempts: 3 },
      ),
    ).rejects.toBe(refusal);
    expect(calls).toBe(1);
  });

  it("does not re-run an unsafe replay after an unknown outcome", async () => {
    const timeout = new RpcTimeoutError(8_000, LOCALNET_RPC_URL);
    let calls = 0;
    await expect(
      withRpcRetry(
        async () => {
          calls += 1;
          throw timeout;
        },
        { ...immediate, replaySafe: false, connection: primary, maxAttempts: 3 },
      ),
    ).rejects.toBe(timeout);
    // The transaction may already be on its way; a second attempt is a second send.
    expect(calls).toBe(1);
  });

  it("will replay after a definitive refusal even when the call is not replay safe", async () => {
    const refused = new RpcHttpStatusError(429, LOCALNET_RPC_URL);
    let calls = 0;
    await expect(
      withRpcRetry(
        async () => {
          calls += 1;
          if (calls === 1) {
            throw refused;
          }
          return "sent";
        },
        { ...immediate, replaySafe: false, endpoints: [LOCALNET_RPC_URL, "http://127.0.0.1:1"], maxAttempts: 3 },
      ),
    ).resolves.toBe("sent");
    expect(calls).toBe(2);
  });

  it("honours a caller abort before it spends the budget", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await expect(
      withRpcRetry(
        async () => {
          calls += 1;
          return "never";
        },
        { ...immediate, signal: controller.signal, connection: primary },
      ),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });

  it("runs the operation against the connection it was given", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse(7));
    const connection = getConnection({ rpcUrl: LOCALNET_RPC_URL });
    const slot = await withRpcRetry((target) => target.getSlot(), { ...immediate, connection });
    expect(slot).toBe(7);
  });
});

/**
 * A JSON-RPC response web3.js will accept. `createRpcResult` (`lib/index.cjs.js:4722-4734`)
 * declares `id` as `string()`, and this fixture proves it: the same body with a numeric `id`
 * is rejected by the union before `result` is read — a stub that copies a spec's example
 * response fails for a reason that has nothing to do with the code under test.
 */
function jsonResponse(result: number): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result }), { status: 200 });
}

async function catchRejection(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return null;
}
