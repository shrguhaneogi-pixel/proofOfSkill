/**
 * Structured logging for the evaluation → issuance path: one JSON object per event,
 * correlation id on every line, and redaction that is the emitter's job rather than
 * the caller's.
 *
 * WHY this exists: the two requests that mint a credential (`POST /api/evaluate` then
 * `POST /api/issue`) each touch a different secret — `AI_API_KEY` on the way in,
 * `ISSUER_PRIVATE_KEY` and `ATTESTATION_SECRET` on the way out — and the failure text
 * operators need to read (`signed.error`, `IssueResult.message`, a JSON-RPC body echo)
 * is produced next to those values. A `console.log(obj)` therefore leaks unless redaction
 * sits between the object and the wire. Everything here is safe-by-default: unknown keys
 * are scrubbed by *shape* as well as by *name*, so a secret that arrives under a key
 * nobody thought of is still caught.
 *
 * Three independent layers, in order of confidence:
 * 1. known values — the actual contents of the secret env vars (plus their encodings) are
 *    substring-matched out of every string, including Error messages and stack text;
 * 2. key names — a normalised deny-list (`issuerSecretKey`, `api_key`, `ATTESTATION_SECRET`…)
 *    drops the whole value, at any depth;
 * 3. shapes — an array of ≥ 32 bytes-sized integers (the exact `solana-keygen` output), a
 *    base58 run of ≥ 58 characters (a 64-byte secret, a signature), a `payload.signature`
 *    two-segment token, and credentials inside a logged URL.
 *
 * A caller who *knows* a value is public opts it back in with `safeField(...)`, which
 * disables layers 2–3 for that value only; layer 1 still applies, because a value the
 * server holds as a secret is never safe to print.
 *
 * `process.env` is read at emit time, never at import time (see `lib/env.server.ts`), so
 * `next build` is unaffected and a test can change the env between emissions.
 */
import "server-only";

import { createHash, randomUUID } from "node:crypto";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Extra context for one event. Never named `payload`/`data` on purpose: it is scrubbed. */
export type LogFields = Record<string, unknown>;

export type LogRecord = {
  time: string;
  level: LogLevel;
  event: string;
  correlationId: string;
} & LogFields;

/** Where a serialized line goes. `null`/`undefined` in `configureLog` restores the default. */
export type LogWriter = (line: string, level: LogLevel) => void;

/** The header an upstream proxy or the browser sends to join its own spans to ours. */
export const CORRELATION_ID_HEADER = "x-correlation-id";

/** Bucket id for events emitted outside a request (startup, scripts, background jobs). */
export const SYSTEM_CORRELATION_ID_PREFIX = "system";

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const KNOWN_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];
const DEFAULT_LEVEL: LogLevel = "info";

/** Bound the record: a submission body must not become a log line. */
const MAX_STRING_CHARS = 1000;
const MAX_STACK_LINES = 8;
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 16;

const RESERVED_FIELDS: readonly string[] = ["time", "level", "event", "correlationId"];

/**
 * Normalised (lowercased, non-alphanumerics removed) names whose *value* is dropped whole.
 * Matching is exact-or-suffix, never substring: `credentialPda`, `evidenceHash`,
 * `walletPublicKey` and `blockhash` are public and must stay readable, while a substring
 * rule on "key" would redact `sortKey` and `cacheKey` for nothing.
 *
 * `signature` and `signer` are deliberately **absent**: a transaction signature and a
 * signer address are the two most useful public handles an operator has, and neither name
 * implies a secret here. A 64-byte base58 signature is still caught by the shape layer, so
 * logging one requires `safeField(...)` — which is the point: it makes the caller state out
 * loud that the value is a public transaction signature and not a keypair.
 */
const SECRET_NAME_EXACT: ReadonlySet<string> = new Set([
  "attestation",
  "attestationmaterial",
  "attestationpayload",
  "authorization",
  "authtoken",
  "cookie",
  "credentials",
  "keystore",
  "mnemonic",
  "passphrase",
  "password",
  "privatekey",
  "secret",
  "seed",
  "sessiontoken",
  "setcookie",
  "token",
]);

const SECRET_NAME_SUFFIXES: readonly string[] = [
  "accesskey",
  "accesstoken",
  "apikey",
  "authtoken",
  "bearertoken",
  "clientsecret",
  "cookie",
  "idtoken",
  "keymaterial",
  "keypair",
  "mnemonic",
  "passphrase",
  "password",
  "privatekey",
  "refreshtoken",
  "secret",
  "secretkey",
  "seedphrase",
  "sessiontoken",
  "signingkey",
  "signerkey",
  "token",
];

/** A 64-byte ed25519 secret key, a tx signature, a base58 blob: never a public address (≤ 44). */
const BASE58_LONG_PATTERN = /[1-9A-HJ-NP-Za-km-z]{58,}/g;
/**
 * The `base64url(payload).base64url(hmac)` attestation shape from `lib/attestation/sign.ts`.
 * Unanchored and global so a token quoted inside an Error message is caught too; each
 * segment must be 16+ characters, which no `file.ext` in this repo reaches.
 */
const TWO_SEGMENT_TOKEN_PATTERN = /[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g;
const URL_CREDENTIAL_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi;
const URL_SECRET_PARAM_PATTERN = /([?&](?:key|token|api[-_]?key|secret|access[-_]?token)=)[^&#\s]*/gi;
/**
 * Control characters would let one field forge additional lines in a non-JSON sink.
 * Tab and newline survive, because `JSON.stringify` escapes them and a readable stack
 * is worth more than a second belt on the same harness.
 */
const CONTROL_CHARS_PATTERN = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

const REDACTED = "[redacted]";

function redactedByRule(rule: string): string {
  return `[redacted:${rule}]`;
}

/**
 * A value the caller asserts is public (a wallet address, a tx signature, an account
 * length). Layers 2–3 are skipped for it; known-secret values are still scrubbed out of
 * any string inside it.
 */
export class TrustedValue<T> {
  readonly value: T;

  constructor(value: T) {
    this.value = value;
  }
}

export function safeField<T>(value: T): TrustedValue<T> {
  return new TrustedValue(value);
}

/** `"attestation"` → `"attestation"`; `"issuer_private_key"` → `"issuerprivatekey"`. */
function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSecretKeyName(key: string): boolean {
  const normalised = normaliseKey(key);
  if (SECRET_NAME_EXACT.has(normalised)) {
    return true;
  }
  return SECRET_NAME_SUFFIXES.some((suffix) => normalised.endsWith(suffix));
}

/* -------------------------------------------------------------------------- *
 * Known secret values, read from the environment at emit time.
 * -------------------------------------------------------------------------- */

type Needle = { readonly value: string; readonly label: string };

type NeedleCache = {
  /** Raw env snapshot the needles were built from, for invalidation only. */
  sources: Record<string, string>;
  needles: Needle[];
};

let needleCache: NeedleCache | null = null;

function pushEncoded(text: string, label: string, out: Needle[]): void {
  if (text.length >= 8 && !out.some((needle) => needle.value === text)) {
    out.push({ value: text, label });
  }
}

/**
 * Every encoding of a secret we can cheaply derive, because the leaked form is rarely
 * the one that was configured: the raw JSON array, the same array with no spaces, the
 * comma-separated bytes, and the bytes as hex and as base58 all describe one keypair.
 *
 * Deliberately *not* imported from `lib/attestation/sign.ts`: redaction must not weaken
 * when the signer is refactored, and this module must not gain a dependency on the
 * challenge catalogue through it. The few lines of decoding here are duplication on
 * purpose.
 */
function needlesFor(label: string, material: string, out: Needle[]): void {
  const trimmed = material.trim();
  if (trimmed === "") {
    return;
  }
  pushEncoded(trimmed, label, out);
  const compact = trimmed.replace(/\s+/g, "");
  pushEncoded(compact, label, out);
  pushEncoded(compact.replace(/[\[\]]/g, ""), label, out);

  let bytes: Uint8Array | null = null;
  if (/^\[?\s*\d+\s*(?:,\s*\d+\s*)+\]?$/u.test(trimmed)) {
    try {
      const parsed: unknown = JSON.parse(trimmed.startsWith("[") ? trimmed : `[${trimmed}]`);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((b) => Number.isInteger(b) && (b as number) >= 0 && (b as number) <= 255)) {
        bytes = Uint8Array.from(parsed as number[]);
      }
    } catch {
      bytes = null;
    }
  } else if (/^(?:[0-9a-f]{2})+$/i.test(trimmed)) {
    bytes = Uint8Array.from(Buffer.from(trimmed, "hex"));
  } else if (/^[A-Za-z0-9+/=_-]{16,}$/u.test(trimmed)) {
    bytes = Uint8Array.from(Buffer.from(trimmed, "base64url"));
  }
  if (bytes === null || bytes.length < 16) {
    return;
  }
  pushEncoded(Buffer.from(bytes).toString("hex"), label, out);
  pushEncoded(Buffer.from(bytes).toString("hex").toUpperCase(), label, out);
  pushEncoded(Buffer.from(bytes).toString("base64url"), label, out);
  pushEncoded(Array.from(bytes).join(","), label, out);
  pushEncoded(toBase58(bytes), label, out);
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Minimal base58 encode: only used to build scrub patterns, never for correctness. */
function toBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) {
    return "";
  }
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) {
    zeros += 1;
  }
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i += 1) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j += 1) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    out += BASE58_ALPHABET[digits[i]];
  }
  return out;
}

function envSnapshot(): Record<string, string> {
  const names = ["ATTESTATION_SECRET", "AI_API_KEY", "ISSUER_PRIVATE_KEY", "OPENAI_API_KEY"];
  const sources: Record<string, string> = {};
  for (const name of names) {
    sources[name] = process.env[name] ?? "";
  }
  return sources;
}

function knownNeedles(): Needle[] {
  const sources = envSnapshot();
  if (needleCache !== null && sameSources(needleCache.sources, sources)) {
    return needleCache.needles;
  }
  const needles: Needle[] = [];
  for (const [name, raw] of Object.entries(sources)) {
    if (raw !== "") {
      needlesFor(name, raw, needles);
    }
  }
  // Longest first: a hex secret is a substring of its own uppercase form's neighbours, and
  // replacing a short needle first could leave a fragment of a longer one behind.
  needles.sort((a, b) => b.value.length - a.value.length);
  needleCache = { sources, needles };
  return needles;
}

function sameSources(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/**
 * Layer 1. Textual scrub of anything that is not a field name: Error messages, stack
 * frames, a JSON-RPC body that echoed the request. Returns the input unchanged when no
 * rule fires, which keeps `ATTESTATION_SECRET is not configured` (a key *name* operators
 * must see) intact.
 */
function scrubText(text: string): string {
  let out = text.replace(CONTROL_CHARS_PATTERN, " ");
  for (const needle of knownNeedles()) {
    if (out.includes(needle.value)) {
      out = out.split(needle.value).join(redactedByRule(`env:${needle.label}`));
    }
  }
  out = out.replace(URL_CREDENTIAL_PATTERN, "$1[redacted]@");
  out = out.replace(URL_SECRET_PARAM_PATTERN, "$1");
  out = out.replace(TWO_SEGMENT_TOKEN_PATTERN, redactedByRule("attestation-token"));
  return out.replace(BASE58_LONG_PATTERN, redactedByRule("base58"));
}

/* -------------------------------------------------------------------------- *
 * Value sanitisation.
 * -------------------------------------------------------------------------- */

function truncate(text: string): string {
  if (text.length <= MAX_STRING_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_STRING_CHARS)}…[+${text.length - MAX_STRING_CHARS} chars]`;
}

function isByteLikeArray(values: readonly unknown[]): boolean {
  if (values.length < 32) {
    return false;
  }
  return values.every((entry) => typeof entry === "number" && Number.isInteger(entry) && entry >= 0 && entry <= 255);
}

/** A `Uint8Array` printed by `JSON.stringify` becomes `{"0":12,"1":45,…}` — same shape rule. */
function isByteLikeRecord(record: Record<string, unknown>): boolean {
  const keys = Object.keys(record);
  if (keys.length < 32) {
    return false;
  }
  for (let i = 0; i < keys.length; i += 1) {
    if (keys[i] !== String(i)) {
      return false;
    }
  }
  return isByteLikeArray(Object.values(record));
}

function sanitizeString(value: string, trusted: boolean): string {
  // Layer 1 runs on trusted values too: `safeField(env.issuerSecretKey)` is a caller bug,
  // and the point of redaction is that a caller bug is not a leak.
  return truncate(trusted ? scrubKnownValuesOnly(value) : scrubText(value));
}

function scrubKnownValuesOnly(text: string): string {
  let out = text.replace(CONTROL_CHARS_PATTERN, " ");
  for (const needle of knownNeedles()) {
    if (out.includes(needle.value)) {
      out = out.split(needle.value).join(redactedByRule(`env:${needle.label}`));
    }
  }
  return out;
}

function sanitizeValue(value: unknown, depth: number, trusted: boolean): unknown {
  if (value === null || value === undefined) {
    return value ?? null;
  }
  switch (typeof value) {
    case "string":
      return sanitizeString(value, trusted);
    case "boolean":
      return value;
    case "number":
      // `JSON.stringify` turns these into `null`, which reads as "no value" instead of
      // "impossible value" — keep the distinction.
      return Number.isFinite(value) ? value : String(value);
    case "bigint":
      return sanitizeString(`${value}n`, trusted);
    case "function":
      return `[Function ${value.name || "anonymous"}]`;
    case "symbol":
      return sanitizeString(`Symbol(${String(value.description)})`, trusted);
    default:
      break;
  }

  if (value instanceof TrustedValue) {
    return sanitizeValue(value.value, depth, true);
  }
  if (depth >= MAX_DEPTH) {
    return "[max-depth]";
  }
  if (value instanceof Error) {
    return sanitizeError(value, depth);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Uint8Array) {
    // Byte arrays are almost always keys, signatures, or account data; the length is the
    // only part worth printing, and it is enough to debug a layout mismatch.
    return value.length >= 32 && !trusted
      ? redactedByRule(`bytes:${value.length}`)
      : { type: value.constructor.name, length: value.length };
  }
  if (Array.isArray(value)) {
    if (!trusted && isByteLikeArray(value)) {
      return redactedByRule(`byte-array:${value.length}`);
    }
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((entry) => sanitizeValue(entry, depth + 1, trusted));
    if (value.length > MAX_ARRAY_ITEMS) {
      items.push(`…[+${value.length - MAX_ARRAY_ITEMS} items]`);
    }
    return items;
  }
  if (value instanceof Map) {
    return Object.fromEntries(
      Array.from(value.entries()).map(([key, entry]) => [String(key), sanitizeValue(entry, depth + 1, trusted)]),
    );
  }
  if (value instanceof Set) {
    return sanitizeValue(Array.from(value.values()), depth, trusted);
  }
  if (typeof value === "object") {
    return sanitizeRecord(value as Record<string, unknown>, depth, trusted);
  }
  return sanitizeString(String(value), trusted);
}

function sanitizeRecord(record: Record<string, unknown>, depth: number, trusted: boolean): unknown {
  if (!trusted && isByteLikeRecord(record)) {
    return redactedByRule(`byte-object:${Object.keys(record).length}`);
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!trusted && isSecretKeyName(key)) {
      out[key] = redactedByRule(`key:${normaliseKey(key)}`);
      continue;
    }
    out[key] = sanitizeValue(value, depth + 1, trusted);
  }
  return out;
}

/**
 * Errors are the highest-risk carrier: a web3.js or provider message quotes the request
 * it failed on. `stack` is kept (operators need the frame) but line-capped and scrubbed,
 * and `cause` is followed to a bounded depth because `lib/errors/signals.ts` reads it too.
 */
function sanitizeError(error: Error, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: "Error",
    name: sanitizeString(error.name || "Error", false),
    message: sanitizeString(error.message, false),
  };
  if (typeof error.stack === "string") {
    out.stack = error.stack
      .split("\n")
      .slice(0, MAX_STACK_LINES)
      .map((line) => sanitizeString(line.trimEnd(), false))
      .join("\n");
  }
  const code = (error as unknown as { code?: unknown }).code;
  if (code !== undefined) {
    out.code = sanitizeValue(code, depth + 1, false);
  }
  const status = (error as unknown as { status?: unknown }).status;
  if (typeof status === "number") {
    out.status = status;
  }
  const cause = (error as unknown as { cause?: unknown }).cause;
  if (cause !== undefined && cause !== null) {
    // Recurse under the same depth budget, which bounds how far a `cause` chain is walked.
    out.cause = sanitizeValue(cause, depth + 1, false);
  }
  return out;
}

/* -------------------------------------------------------------------------- *
 * Correlation ids.
 * -------------------------------------------------------------------------- */

/**
 * 8-4-4-4-12 lowercase hex. Opaque, unguessable, and inside the acceptance pattern, so a
 * minted id always survives a round trip through an inbound header.
 */
export function newCorrelationId(): string {
  return randomUUID();
}

/** Ids from outside are untrusted input: no CR/LF, no spaces, no megabyte, or one line could be forged. */
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/u;

export function parseCorrelationId(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const candidate = raw.trim();
  return CORRELATION_ID_PATTERN.test(candidate) ? candidate : null;
}

export type HeadersLike = Headers | Record<string, string | string[] | undefined> | undefined;

function headerValue(headers: HeadersLike, name: string): string | null {
  if (headers === undefined || headers === null) {
    return null;
  }
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name);
  }
  const entry = (headers as Record<string, string | string[] | undefined>)[name] ?? (headers as Record<string, string | string[] | undefined>)[name.toLowerCase()];
  if (Array.isArray(entry)) {
    return entry[0] ?? null;
  }
  return typeof entry === "string" ? entry : null;
}

/** The inbound `x-correlation-id`, or `null` when absent or unusable. */
export function inboundCorrelationId(headers: HeadersLike): string | null {
  return parseCorrelationId(headerValue(headers, CORRELATION_ID_HEADER));
}

/** One id per process, so a line emitted outside a request is still groupable. */
let processCorrelationId: string | null = null;

export function systemCorrelationId(): string {
  if (processCorrelationId === null) {
    processCorrelationId = `${SYSTEM_CORRELATION_ID_PREFIX}:${randomUUID().slice(0, 8)}`;
  }
  return processCorrelationId;
}

/* -------------------------------------------------------------------------- *
 * The attestation token as the only cross-request join key.
 * -------------------------------------------------------------------------- */

const ATTESTATION_REF_DOMAIN = "proofofskill/attestation-ref-v1\n";

/**
 * A short, non-reversible handle for an attestation token: `sha256(domain ‖ token)`, first
 * 12 hex characters.
 *
 * This is what lets an operator follow one user end to end. `/api/evaluate` and
 * `/api/issue` are separate HTTP requests, so a per-request correlation id cannot span
 * them; the token is the only artefact that exists in both. A truncated digest identifies
 * it without printing it — the token is 96+ characters of base64url whose second segment
 * is an HMAC, so inverting 48 bits of the digest is not a path to a forgeable token.
 *
 * Returns `null` for anything that is not a string, so a missing token never logs `""`.
 */
export function attestationRef(token: unknown): string | null {
  if (typeof token !== "string" || token.trim() === "") {
    return null;
  }
  return createHash("sha256").update(ATTESTATION_REF_DOMAIN, "utf8").update(token, "utf8").digest("hex").slice(0, 12);
}

/* -------------------------------------------------------------------------- *
 * Emission.
 * -------------------------------------------------------------------------- */

type LogConfig = {
  writer?: LogWriter | null;
  level?: LogLevel | null;
  now?: (() => number) | null;
};

const config: { writer: LogWriter | null; level: LogLevel | null; now: (() => number) | null } = {
  writer: null,
  level: null,
  now: null,
};

function defaultWriter(line: string, level: LogLevel): void {
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}

/**
 * Deployment/test seam. `undefined` leaves a setting alone; `null` restores the default
 * (stdout/stderr, env-driven level, wall clock). Changing `ATTESTATION_SECRET`,
 * `AI_API_KEY` or `ISSUER_PRIVATE_KEY` between emissions needs no call here — the needle
 * cache is invalidated by comparing the raw env values each time.
 */
export function configureLog(options: LogConfig): void {
  if ("writer" in options) {
    config.writer = options.writer ?? null;
  }
  if ("level" in options) {
    config.level = options.level ?? null;
  }
  if ("now" in options) {
    config.now = options.now ?? null;
  }
}

function configuredLevel(): LogLevel {
  if (config.level !== null) {
    return config.level;
  }
  const raw = (process.env.LOG_LEVEL ?? "").trim().toLowerCase();
  return (KNOWN_LEVELS as readonly string[]).includes(raw) ? (raw as LogLevel) : DEFAULT_LEVEL;
}

function shouldEmit(level: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[configuredLevel()];
}

/**
 * Builds and writes one record. Exported for call sites that have no correlation id of
 * their own (a script, a module init); everything else should hold a `Logger`.
 *
 * `correlationId` defaults to the per-process id. Reserved fields are the emitter's: a
 * context key called `level` is dropped rather than allowed to overwrite it.
 */
export function emitLogEvent(
  level: LogLevel,
  event: string,
  fields?: LogFields,
  correlationId?: string,
): LogRecord | null {
  if (!shouldEmit(level)) {
    return null;
  }
  const record: LogRecord = {
    time: new Date(config.now === null ? Date.now() : config.now()).toISOString(),
    level,
    event: sanitizeString(event, false),
    correlationId: parseCorrelationId(correlationId) ?? systemCorrelationId(),
  };
  if (fields !== undefined) {
    const sanitized = sanitizeValue(fields, 0, false);
    if (sanitized !== null && typeof sanitized === "object" && !Array.isArray(sanitized)) {
      for (const [key, value] of Object.entries(sanitized as Record<string, unknown>)) {
        if (RESERVED_FIELDS.includes(key)) {
          continue;
        }
        record[key] = value;
      }
    } else {
      // A non-object `fields` (a stray string, an array) still has to be visible.
      record.fields = sanitized;
    }
  }

  let line: string;
  try {
    line = JSON.stringify(record);
  } catch {
    // `sanitizeValue` removes every unserializable shape, so this only fires on a getter
    // that throws. Losing the context is correct; losing the line is not.
    line = JSON.stringify({ time: record.time, level, event: record.event, correlationId: record.correlationId, redactionFailure: true });
  }
  (config.writer ?? defaultWriter)(line, level);
  return record;
}

export type Logger = {
  readonly correlationId: string;
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** A new id for work that must not share this request's span (a fan-out, a retry batch). */
  withCorrelationId(correlationId: string): Logger;
};

/**
 * One logger per request. An inbound `x-correlation-id` is reused verbatim (when it is
 * well formed) so the id a caller put on the wire is the id on every line; otherwise a
 * fresh one is minted and the route should echo it back with
 * `CORRELATION_ID_HEADER` so the browser can reuse it on the next request.
 */
export function createLogger(options: { correlationId?: string | null; headers?: HeadersLike } = {}): Logger {
  const correlationId = parseCorrelationId(options.correlationId ?? undefined) ?? inboundCorrelationId(options.headers) ?? newCorrelationId();
  return buildLogger(correlationId);
}

/** Convenience for a route handler: `const log = loggerFromRequest(request)`. */
export function loggerFromRequest(request: { headers: HeadersLike }): Logger {
  return createLogger({ headers: request.headers });
}

function buildLogger(correlationId: string): Logger {
  return {
    correlationId,
    debug(event, fields) {
      emitLogEvent("debug", event, fields, correlationId);
    },
    info(event, fields) {
      emitLogEvent("info", event, fields, correlationId);
    },
    warn(event, fields) {
      emitLogEvent("warn", event, fields, correlationId);
    },
    error(event, fields) {
      emitLogEvent("error", event, fields, correlationId);
    },
    withCorrelationId(next) {
      return buildLogger(parseCorrelationId(next) ?? correlationId);
    },
  };
}

/**
 * The scrubber on its own, for a caller that must hand an object to something that is not
 * this emitter (a response body echoed back for debugging, an assertion in a test).
 * It applies the same three layers and returns a JSON-safe value.
 */
export function sanitizeLogValue(value: unknown): unknown {
  return sanitizeValue(value, 0, false);
}

/** Test seam: the current redaction needle count, so a test can prove env pickup without printing a value. */
export function knownSecretCount(): number {
  return knownNeedles().length;
}
