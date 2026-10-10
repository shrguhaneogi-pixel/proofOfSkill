import { describe, expect, it, afterEach, vi } from "vitest";

// `lib/telemetry/log.ts` is server-only (it reads secret env vars and `node:crypto`).
vi.mock("server-only", () => ({ default: {} }));

import {
  CORRELATION_ID_HEADER,
  attestationRef,
  configureLog,
  createLogger,
  emitLogEvent,
  inboundCorrelationId,
  loggerFromRequest,
  newCorrelationId,
  parseCorrelationId,
  safeField,
  sanitizeLogValue,
  systemCorrelationId,
} from "./log";
import { signAttestation } from "../attestation/sign";

const SECRET_KEY_BYTES = Array.from({ length: 64 }, (_, i) => (i * 7 + 3) % 256);
const SECRET_KEY_JSON = `[${SECRET_KEY_BYTES.join(",")}]`;
const ATTESTATION_SECRET_HEX = "9f3c1d7be0a55c82417bd6e9f0c3a2d14b8e6f90ad3c5b7e1f2d4c6a8b0d2e4f6";
// Assembled at runtime, never written as a literal: the redactor must still catch a
// string with exactly this shape, but a committed `sk-or-v1-<64 hex>` is indistinguishable
// from a live provider key and GitHub push protection (rightly) blocks the push.
const AI_KEY = ["sk-or-v1", "4f9a".repeat(16)].join("-");
const WALLET = "Fj4v7qWW7k4sTieBCgjNwQUTMC6yVbfHrSwHhR8tw92j";
/** 88 characters of base58: what a 64-byte secret key looks like once encoded. */
const BASE58_64_BYTES = "3xS7QpR1vGZk8mNc4TbWdY6uJfHaL2eKs9DrPnVtUwXyBgCjMqS5dFhN7RkZb3VtG".padEnd(88, "x");

type Capture = { lines: string[]; levels: string[]; record: (index?: number) => Record<string, unknown> };

function capture(): Capture {
  const lines: string[] = [];
  const levels: string[] = [];
  configureLog({
    writer: (line, level) => {
      lines.push(line);
      levels.push(level);
    },
    level: "debug",
    now: () => Date.parse("2026-10-10T12:00:00.000Z"),
  });
  return {
    lines,
    levels,
    record(index = 0) {
      return JSON.parse(lines[index]) as Record<string, unknown>;
    },
  };
}

const SECRET_ENV_KEYS = ["ATTESTATION_SECRET", "AI_API_KEY", "ISSUER_PRIVATE_KEY", "OPENAI_API_KEY", "LOG_LEVEL"] as const;
const originalEnv: Record<string, string | undefined> = {};
for (const key of SECRET_ENV_KEYS) {
  originalEnv[key] = process.env[key];
}

afterEach(() => {
  configureLog({ writer: null, level: null, now: null });
  for (const key of SECRET_ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

/** Arms the environment the way a real deployment has it, so layer 1 has needles to match. */
function withSecrets(): void {
  process.env.ATTESTATION_SECRET = ATTESTATION_SECRET_HEX;
  process.env.AI_API_KEY = AI_KEY;
  process.env.ISSUER_PRIVATE_KEY = SECRET_KEY_JSON;
}

describe("correlation id", () => {
  it("is a fresh opaque id per mint", () => {
    const first = newCorrelationId();
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(newCorrelationId()).not.toBe(first);
  });

  it("reuses a well formed inbound x-correlation-id verbatim", () => {
    const headers = new Headers({ [CORRELATION_ID_HEADER]: "trace-abc.123:45-6" });
    expect(inboundCorrelationId(headers)).toBe("trace-abc.123:45-6");
    expect(loggerFromRequest({ headers }).correlationId).toBe("trace-abc.123:45-6");
    expect(createLogger({ headers }).correlationId).toBe("trace-abc.123:45-6");
  });

  it("refuses an inbound id that could forge a line or overflow the record", () => {
    expect(parseCorrelationId("ok\r\nFAKE: line")).toBeNull();
    expect(parseCorrelationId("has space")).toBeNull();
    expect(parseCorrelationId("x".repeat(65))).toBeNull();
    expect(parseCorrelationId("")).toBeNull();
    expect(parseCorrelationId(undefined)).toBeNull();

    // A `Headers` object rejects an illegal value outright; a plain record (what a proxy
    // or a test hands us) must still be validated here rather than trusted.
    const captured = capture();
    const log = loggerFromRequest({ headers: { [CORRELATION_ID_HEADER]: "a\nb" } });
    log.info("evaluate.received");
    expect(captured.lines).toHaveLength(1);
    expect(captured.record().correlationId).not.toBe("a\nb");
    expect(String(captured.record().correlationId)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("carries one id across every event of a logger and switches on request", () => {
    const captured = capture();
    const log = createLogger({ correlationId: "req-1" });
    log.info("a");
    log.error("b");
    log.withCorrelationId("req-2").info("c");
    log.withCorrelationId("bad\nid").info("d");
    expect(captured.lines).toHaveLength(4);
    expect(captured.lines.map((line) => (JSON.parse(line) as { correlationId: string }).correlationId)).toEqual([
      "req-1",
      "req-1",
      "req-2",
      "req-1",
    ]);
  });

  it("groups lines emitted outside a request under one process id", () => {
    const captured = capture();
    emitLogEvent("info", "startup.ready");
    emitLogEvent("warn", "startup.slow");
    expect(captured.record(0).correlationId).toBe(systemCorrelationId());
    expect(captured.record(1).correlationId).toBe(systemCorrelationId());
    expect(systemCorrelationId()).toMatch(/^system:[0-9a-f]{8}$/);
  });
});

describe("record shape", () => {
  it("writes exactly one JSON object per event with the four reserved fields and flat context", () => {
    const captured = capture();
    createLogger({ correlationId: "req-1" }).info("evaluate.accepted", {
      wallet: WALLET,
      challengeId: 2,
      score: 91,
      durationMs: 1234,
    });

    expect(captured.lines).toHaveLength(1);
    expect(captured.lines[0]).not.toContain("\n");
    expect(captured.record()).toEqual({
      time: "2026-10-10T12:00:00.000Z",
      level: "info",
      event: "evaluate.accepted",
      correlationId: "req-1",
      wallet: WALLET,
      challengeId: 2,
      score: 91,
      durationMs: 1234,
    });
  });

  it("never lets context overwrite the emitter's own fields", () => {
    const captured = capture();
    emitLogEvent("warn", "x", { level: "error", event: "forged", correlationId: "forged", time: "forged" }, "real-id");
    const record = captured.record();
    expect(record).toMatchObject({ level: "warn", event: "x", correlationId: "real-id", time: "2026-10-10T12:00:00.000Z" });
    expect(record.forged).toBeUndefined();
  });

  it("filters by level, from the configured floor and otherwise from LOG_LEVEL", () => {
    withSecrets();
    const captured = capture();
    configureLog({ level: "warn" });
    captured.lines.length = 0;
    emitLogEvent("info", "dropped");
    emitLogEvent("warn", "kept");
    expect(captured.lines).toHaveLength(1);
    expect(captured.levels).toEqual(["warn"]);

    configureLog({ level: null });
    process.env.LOG_LEVEL = "debug";
    emitLogEvent("debug", "debug_kept");
    expect(captured.lines).toHaveLength(2);

    configureLog({ level: null });
    process.env.LOG_LEVEL = "not-a-level";
    emitLogEvent("debug", "dropped_again");
    emitLogEvent("info", "kept_at_default");
    expect(captured.lines).toHaveLength(3);
  });

  it("keeps a non-object fields argument visible", () => {
    const captured = capture();
    emitLogEvent("info", "x", ["a", "b"] as unknown as Record<string, unknown>, "r");
    expect(captured.record().fields).toEqual(["a", "b"]);
  });
});

describe("redaction: known env values (layer 1)", () => {
  it("removes the configured issuer secret key from a string that only quotes it", () => {
    withSecrets();
    const captured = capture();
    emitLogEvent("error", "issuer.key_rejected", { detail: `bad JSON in ISSUER_PRIVATE_KEY: ${SECRET_KEY_JSON}` }, "r");
    const line = captured.lines[0];
    expect(line).not.toContain(SECRET_KEY_BYTES.join(","));
    expect(line).toContain("[redacted:env:ISSUER_PRIVATE_KEY]");
    // The key *name* is what the operator needs, and it must survive.
    expect(line).toContain("ISSUER_PRIVATE_KEY");
  });

  it("removes the AI key and the attestation secret from an Error message and its stack", () => {
    withSecrets();
    const captured = capture();
    const error = new Error(`HMAC failed with key ${ATTESTATION_SECRET_HEX} and header ${AI_KEY}`);
    emitLogEvent("error", "attestation.mint_failed", { error }, "r");
    const line = captured.lines[0];
    expect(line).not.toContain(ATTESTATION_SECRET_HEX);
    expect(line).not.toContain(AI_KEY);
    const record = captured.record() as { error: { message: string; stack?: string; name: string } };
    expect(record.error.name).toBe("Error");
    expect(record.error.message).toContain("[redacted:env:ATTESTATION_SECRET]");
    expect(record.error.message).toContain("[redacted:env:AI_API_KEY]");
    expect(record.error.stack ?? "").not.toContain(ATTESTATION_SECRET_HEX);
  });

  it("removes a secret that reaches the log through a nested cause", () => {
    withSecrets();
    const captured = capture();
    const inner = new Error(`upstream echoed the request body: ${AI_KEY}`);
    const outer = new Error("AI_UPSTREAM_ERROR", { cause: inner });
    emitLogEvent("error", "evaluate.upstream", { error: outer }, "r");
    const line = captured.lines[0];
    expect(line).not.toContain(AI_KEY);
    const record = captured.record() as { error: { cause: { message: string } } };
    expect(record.error.cause.message).toContain("[redacted:env:AI_API_KEY]");
  });

  it("scrubs credentials and key query params out of a logged RPC URL, keeping the host", () => {
    const captured = capture();
    emitLogEvent("info", "rpc.endpoint", { endpoint: "https://user:hunter2@rpc.example.com/?key=abc123secret&commitment=confirmed" }, "r");
    const message = String(captured.record().endpoint);
    expect(message).not.toContain("hunter2");
    expect(message).not.toContain("abc123secret");
    expect(message).toContain("rpc.example.com");
    expect(message).toContain("commitment=confirmed");
  });

  it("re-reads the environment per emission rather than caching it at import", () => {
    const captured = capture();
    emitLogEvent("info", "before", { value: "sentinel-value-1" }, "r");
    expect(captured.lines[0]).toContain("sentinel-value-1");
    process.env.ATTESTATION_SECRET = "sentinel-value-1";
    captured.lines.length = 0;
    emitLogEvent("info", "after", { value: "sentinel-value-1" }, "r");
    expect(captured.lines[0]).toContain("[redacted:env:ATTESTATION_SECRET]");
  });
});

describe("redaction: key names (layer 2)", () => {
  it("drops a 64-byte key array under every name variant, at any depth", () => {
    const captured = capture();
    emitLogEvent("info", "issue.request", {
      issuerSecretKey: SECRET_KEY_BYTES,
      nested: { deeper: { still: { attestation_secret: SECRET_KEY_BYTES } } },
    }, "r");
    const line = captured.lines[0];
    expect(line).not.toContain(SECRET_KEY_BYTES.join(","));
    const record = captured.record() as {
      issuerSecretKey: string;
      nested: { deeper: { still: { attestation_secret: string } } };
    };
    expect(record.issuerSecretKey).toBe("[redacted:key:issuersecretkey]");
    expect(record.nested.deeper.still.attestation_secret).toBe("[redacted:key:attestationsecret]");
  });

  it("recognises the env variable names themselves, in either case", () => {
    const captured = capture();
    emitLogEvent("info", "env.snapshot", {
      ISSUER_PRIVATE_KEY: SECRET_KEY_JSON,
      ATTESTATION_SECRET: ATTESTATION_SECRET_HEX,
      AI_API_KEY: AI_KEY,
      ai_api_key: AI_KEY,
    }, "r");
    const record = captured.record() as Record<string, string>;
    expect(record.ISSUER_PRIVATE_KEY).toBe("[redacted:key:issuerprivatekey]");
    expect(record.ATTESTATION_SECRET).toBe("[redacted:key:attestationsecret]");
    expect(record.AI_API_KEY).toBe("[redacted:key:aiapikey]");
    expect(record.ai_api_key).toBe("[redacted:key:aiapikey]");
    expect(captured.lines[0]).not.toContain(AI_KEY);
    expect(captured.lines[0]).not.toContain(ATTESTATION_SECRET_HEX);
  });

  it("keeps ordinary numbers and public identifiers while redacting the key shape", () => {
    const captured = capture();
    emitLogEvent("info", "evaluate.scored", {
      score: 91,
      challengeId: 3,
      latencyMs: 42,
      attempts: [1, 2, 3],
      weights: [25, 25, 25, 25],
      wallet: WALLET,
      credentialPda: "Gh1J8K9mQ2nP4rS6tV8xZ0bC2eF4hJ6kL8mN0pQ2rS4",
      blockhash: "5usxT3A1BqkV7pQW2mN9cR6dF4hJ8kL0mN2pQ4rS6tV8",
      completed: SECRET_KEY_BYTES,
    }, "r");
    const record = captured.record() as Record<string, unknown>;
    expect(record.score).toBe(91);
    expect(record.challengeId).toBe(3);
    expect(record.latencyMs).toBe(42);
    expect(record.attempts).toEqual([1, 2, 3]);
    expect(record.weights).toEqual([25, 25, 25, 25]);
    expect(record.wallet).toBe(WALLET);
    expect(record.credentialPda).toBe("Gh1J8K9mQ2nP4rS6tV8xZ0bC2eF4hJ6kL8mN0pQ2rS4");
    expect(record.blockhash).toBe("5usxT3A1BqkV7pQW2mN9cR6dF4hJ8kL0mN2pQ4rS6tV8");
    expect(record.completed).toBe("[redacted:byte-array:64]");
  });
});

describe("redaction: shapes (layer 3)", () => {
  it("redacts a nested array of 64 small integers even under a neutral key name", () => {
    const captured = capture();
    emitLogEvent("info", "x", { material: { blob: { inner: SECRET_KEY_BYTES } } }, "r");
    const record = captured.record() as { material: { blob: { inner: string } } };
    expect(record.material.blob.inner).toBe("[redacted:byte-array:64]");
    expect(captured.lines[0]).not.toContain(SECRET_KEY_BYTES.join(","));
  });

  it("redacts the JSON-printed form of a keypair (an object of indexed bytes)", () => {
    const captured = capture();
    const asObject: Record<string, unknown> = {};
    SECRET_KEY_BYTES.forEach((byte, index) => {
      asObject[String(index)] = byte;
    });
    emitLogEvent("info", "x", { dumped: asObject }, "r");
    expect(captured.record().dumped).toBe(`[redacted:byte-object:64]`);
  });

  it("redacts Uint8Array and Buffer contents by length, not by value", () => {
    const captured = capture();
    emitLogEvent("info", "x", { accountBytes: Uint8Array.from(SECRET_KEY_BYTES), evidence: Uint8Array.from([1, 2, 3]) }, "r");
    const record = captured.record() as { accountBytes: string; evidence: { type: string; length: number } };
    expect(record.accountBytes).toBe("[redacted:bytes:64]");
    expect(record.evidence).toEqual({ type: "Uint8Array", length: 3 });
  });

  it("redacts a base58 64-byte value while keeping a base58 public key readable", () => {
    const captured = capture();
    emitLogEvent("info", "x", { candidate: BASE58_64_BYTES, wallet: WALLET }, "r");
    const record = captured.record() as { candidate: string; wallet: string };
    expect(record.candidate).toContain("[redacted:base58]");
    expect(record.candidate).not.toContain(BASE58_64_BYTES);
    expect(record.wallet).toBe(WALLET);
  });

  it("never logs the attestation token, only its non-reversible ref", () => {
    const token = `${Buffer.from(`{"v":2,"walletPublicKey":"${WALLET}","challengeId":2,"score":91,"exp":99}`,"utf8").toString("base64url")}.${"dQ1W4zX9mK2pL8vN6bR3tY7uI0oPA5sDF6gHjK9lZxc"}`;
    const captured = capture();
    const ref = attestationRef(token);
    expect(ref).toMatch(/^[0-9a-f]{12}$/);
    expect(attestationRef(token)).toBe(ref);
    expect(ref).not.toContain(token);

    emitLogEvent("info", "issue.request", { attestation: token, attestationRef: ref, quoted: `rejected token ${token}` }, "r");
    const line = captured.lines[0];
    const record = captured.record() as { attestation: string; attestationRef: string; quoted: string };
    expect(record.attestation).toBe("[redacted:key:attestation]");
    expect(record.attestationRef).toBe(ref);
    expect(record.quoted).toContain("[redacted:attestation-token]");
    expect(line).not.toContain(token);
    expect(line).not.toContain("dQ1W4zX9mK2pL8vN6bR3tY7uI0oPA5sDF6gHjK9lZxc");
    expect(attestationRef(undefined)).toBeNull();
    expect(attestationRef("   ")).toBeNull();
  });

  it("caps a runaway string instead of logging a whole submission", () => {
    const captured = capture();
    // Spaces and newlines keep this out of the base58 shape rule, so the cap is what fires.
    emitLogEvent("info", "x", { body: "fn main() {\n    let x = 1;\n}\n".repeat(200) }, "r");
    const value = String(captured.record().body);
    expect(value.length).toBeLessThan(1100);
    expect(value).toContain("fn main()");
    expect(value).toContain("[+");
  });

  it("redacts one run inside a longer message instead of dropping the whole message", () => {
    const captured = capture();
    emitLogEvent(
      "warn",
      "rpc.body",
      { body: `JSON-RPC -32603 while parsing [${WALLET}, ${BASE58_64_BYTES}] at slot 341324` },
      "r",
    );
    const body = String(captured.record().body);
    expect(body).toContain("JSON-RPC -32603");
    expect(body).toContain(WALLET);
    expect(body).toContain("slot 341324");
    expect(body).not.toContain(BASE58_64_BYTES);
    expect(body).toContain("[redacted:base58]");
  });

  it("bounds depth, arrays, circular refs, and exotic values without throwing", () => {
    const circular: Record<string, unknown> = { name: "root" };
    circular.self = circular;
    const captured = capture();
    emitLogEvent("info", "x", {
      deep: { a: { b: { c: { d: { e: { f: { g: SECRET_KEY_BYTES } } } } } } },
      many: Array.from({ length: 40 }, (_, i) => i * 1000),
      circular,
      // `BigInt(42)` rather than `42n`: tsconfig targets ES2017, where a bigint literal
      // does not typecheck.
      big: BigInt(42),
      notANumber: Number.NaN,
      infinite: Number.POSITIVE_INFINITY,
      fn() {
        return 1;
      },
      when: new Date("2026-10-10T12:00:00.000Z"),
      map: new Map([["k", "v"]]),
      set: new Set(["s"]),
    }, "r");

    const line = captured.lines[0];
    expect(line).not.toContain(SECRET_KEY_BYTES.join(","));
    const record = captured.record() as Record<string, unknown>;
    expect(record.big).toBe("42n");
    expect(record.notANumber).toBe("NaN");
    expect(record.infinite).toBe("Infinity");
    expect(record.when).toBe("2026-10-10T12:00:00.000Z");
    expect(record.map).toEqual({ k: "v" });
    expect(record.set).toEqual(["s"]);
    expect(String(record.fn)).toContain("[Function");
    expect(record.many).toEqual([...Array.from({ length: 16 }, (_, i) => i * 1000), "…[+24 items]"]);
    expect(JSON.stringify((record.circular as Record<string, unknown>).self)).toContain("max-depth");
    // The secret sits below the depth budget, so it is never reached at all.
    expect(JSON.stringify(record.deep)).toBe('{"a":{"b":{"c":{"d":{"e":"[max-depth]"}}}}}');
  });

  it("cannot be made to forge a second line from field content", () => {
    const captured = capture();
    emitLogEvent("info", "x", {注入: `{"level":"error","event":"fake"}\n` + "x".repeat(2000) }, "r");
    expect(captured.lines).toHaveLength(1);
    expect(captured.lines[0].split("\n")).toHaveLength(1);
    expect(JSON.parse(captured.lines[0])).toBeTruthy();
  });
});

describe("cross-request join key", () => {
  it("links an evaluation to its issuance through a real attestation token", () => {
    withSecrets();
    const signed = signAttestation(
      {
        walletPublicKey: WALLET,
        challengeId: 2,
        score: 91,
        evidenceHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      },
      { secret: ATTESTATION_SECRET_HEX },
    );
    if (!signed.ok) {
      throw new Error(`fixture failed to mint: ${signed.error}`);
    }
    const token = signed.data;

    const captured = capture();
    // Two separate HTTP requests: `/api/evaluate` minted the token, `/api/issue` redeemed it.
    // The browser sent no shared `x-correlation-id`, so the two ids differ by construction.
    createLogger({ correlationId: "eval-1" }).info("evaluate.attestation_minted", { attestationRef: attestationRef(token) });
    createLogger({ correlationId: "issue-1" }).info("issue.attestation_redeemed", { attestation: token, attestationRef: attestationRef(token) });

    const first = captured.record(0) as { attestationRef: string; correlationId: string };
    const second = captured.record(1) as { attestation: string; attestationRef: string; correlationId: string };
    expect(first.attestationRef).toMatch(/^[0-9a-f]{12}$/);
    expect(second.attestationRef).toBe(first.attestationRef);
    expect(first.correlationId).not.toBe(second.correlationId);
    // Neither segment of the token reaches either line.
    expect(captured.lines.join("")).not.toContain(token);
    expect(captured.lines.join("")).not.toContain(token.split(".")[1]);
    expect(second.attestation).toBe("[redacted:key:attestation]");
  });
});

describe("safeField escape hatch", () => {
  it("lets a caller keep a long public value readable", () => {
    const captured = capture();
    emitLogEvent("info", "tx.sent", { signature: BASE58_64_BYTES, trusted: safeField(BASE58_64_BYTES) }, "r");
    const record = captured.record() as { signature: string; trusted: string };
    expect(record.signature).toContain("[redacted:base58]");
    expect(record.trusted).toBe(BASE58_64_BYTES);
  });

  it("still scrubs a configured secret out of a trusted value", () => {
    withSecrets();
    const captured = capture();
    emitLogEvent("info", "x", { leaked: safeField(`key=${AI_KEY}`) }, "r");
    expect(captured.lines[0]).not.toContain(AI_KEY);
    expect(String(captured.record().leaked)).toContain("[redacted:env:AI_API_KEY]");
  });

  it("is exported for callers that want to pre-sanitize before handing data to another sink", () => {
    withSecrets();
    const sanitized = sanitizeLogValue({ attestation: SECRET_KEY_BYTES, ok: 1 }) as Record<string, unknown>;
    expect(sanitized.attestation).toBe("[redacted:key:attestation]");
    expect(sanitized.ok).toBe(1);
  });
});
