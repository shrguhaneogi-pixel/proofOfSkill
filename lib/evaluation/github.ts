/**
 * Repository evidence: pull real file contents for a submitted GitHub URL so the
 * evaluator grades code instead of a claim (roadmap Phase 3).
 *
 * WHY FETCHING HERE IS COMPATIBLE WITH docs/rules.md ("no fetching user-supplied
 * URLs server-side"): nothing in this module ever fetches a caller-supplied URL.
 * `REPO_URL_PATTERN` (the same pattern the submission schema validates against)
 * pins the scheme, host, and two-segment path first; only the `owner` and `repo`
 * path segments — re-checked against a path-segment grammar — reach the injected
 * client, and the client talks to the GitHub REST API. There is no host, port,
 * scheme, or deep path for a candidate to choose, so there is no SSRF surface.
 *
 * HOW THE NETWORK IS REACHED: by injection, exactly like the AI side. This module
 * reads no `process.env` and constructs no client on the path that
 * `fetchRepositoryEvidence` runs; `createOctokitGitHubClient` is the one place the
 * SDK is built, mirroring `openai-client.ts` next to `evaluator.ts`. Tests inject a
 * stub and need no socket.
 *
 * FAILURES ARE VALUES: fetching happens at request time, on a resource the
 * candidate controls, so every path returns a typed reason the route can map to a
 * status. Nothing throws, and no message ever contains the token, the upstream
 * response body, or upstream error text — only our own wording plus, where
 * GitHub's headers state it, a retry delay.
 *
 * UNTRUSTED IN BOTH DIRECTIONS: repository content is attacker-controlled. This
 * module returns it verbatim (so the evidence digest describes what was actually
 * fetched) and `prompt.ts` neutralises it before it enters the model prompt.
 */
import "server-only";

import { Octokit } from "@octokit/rest";

import { sha256Hex } from "../hashing/evidence-hash";
import { REPO_URL_PATTERN } from "./limits";

/* ------------------------------------------------------------------ *
 * Budgets
 * ------------------------------------------------------------------ */

/**
 * A single source file admitted to the prompt. At or above this size a file is
 * skipped rather than truncated: half a file misrepresents the artefact being
 * graded, and a candidate can always point at a smaller file.
 */
export const MAX_FILE_BYTES = 50_000;

/** How many files are admitted. Small on purpose — the model grades a sample, and the prompt is shared with the submission text. */
export const MAX_FILES = 8;

/** Hard ceiling on the bytes of repository content carried into one evaluation. */
export const MAX_TOTAL_BYTES = 64_000;

/**
 * Recursive trees are capped by GitHub at 100k entries (`truncated: true`), but
 * the response is already unusably large long before that. Over this count the
 * repository is refused instead of walked.
 */
export const MAX_TREE_ENTRIES = 50_000;

/**
 * Blob fetches per evaluation. The selection walk can consume one call per
 * candidate, so without this a repo whose first dozen eligible files are all
 * unreadable would spend a dozen API calls for nothing.
 */
export const MAX_BLOB_FETCHES = 16;

export type RepositoryEvidenceLimits = {
  maxFileBytes: number;
  maxFiles: number;
  maxTotalBytes: number;
  maxTreeEntries: number;
  maxBlobFetches: number;
};

export const DEFAULT_LIMITS: RepositoryEvidenceLimits = {
  maxFileBytes: MAX_FILE_BYTES,
  maxFiles: MAX_FILES,
  maxTotalBytes: MAX_TOTAL_BYTES,
  maxTreeEntries: MAX_TREE_ENTRIES,
  maxBlobFetches: MAX_BLOB_FETCHES,
};

/* ------------------------------------------------------------------ *
 * File classification
 * ------------------------------------------------------------------ */

/**
 * Extension allow-list, in the order the selection walk prefers them: a repo with
 * two hundred eligible files gets its implementation to the model, not its
 * README. Anything outside the three tiers is ignored, so images, archives,
 * native objects, and extensionless files never reach a prompt.
 */
const EXTENSION_TIERS: readonly (readonly string[])[] = [
  [
    "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "java", "kt", "kts", "swift", "c", "h", "cc", "cpp",
    "hpp", "cs", "rb", "php", "scala", "lua", "sol", "cairo", "zig", "ex", "exs", "erl", "hs", "ml", "nim", "v",
    "dart", "r", "sql", "sh", "bash", "tf", "proto", "graphql", "prisma", "idl",
  ],
  ["toml", "json", "jsonc", "json5", "yaml", "yml", "nix", "cfg", "ini", "mk", "cmake", "gradle", "gql"],
  ["md", "mdx", "rst", "txt", "html", "css", "scss"],
];

/**
 * Generated and dependency trees. They are the loudest thing in a repository and
 * say nothing about the candidate, so each would consume a slot in an 8-file
 * budget.
 */
const IGNORED_DIRECTORY_SEGMENTS = new Set([
  "node_modules", "vendor", "target", "dist", "build", "out", "coverage", ".git", ".next", ".svelte", ".turbo",
  "__pycache__", ".venv", "venv", "bower_components", "pods", "third_party", "deps", "_build", "tmp", ".cache",
  ".github", ".vscode", ".idea", "secrets",
]);

/**
 * Lockfiles and other machine-written artefacts, matched on the lowercased final
 * path segment. Everything ending in `.lock` is covered separately by
 * `IGNORED_NAME_SUFFIXES`.
 */
const IGNORED_FILE_NAMES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "npm-shrinkwrap.json", "cargo.lock", "gemfile.lock",
  "composer.lock", "poetry.lock", "pipfile.lock", "uv.lock", "bun.lock", "bun.lockb", "deno.lock", "go.sum",
  "mix.lock", "flake.lock", "podfile.lock", "conda-lock.txt", "license", "license.md", "license.txt", "copying",
  "copying.md", "notice", "notice.txt",
]);

const IGNORED_NAME_SUFFIXES = [".min.js", ".min.css", ".d.ts", ".snap", ".generated.ts", ".generated.rs", ".lock"];

/**
 * Names that so often hold a credential that reading them into a third-party
 * model prompt is its own leak — of the candidate's secrets, not ours.
 *
 * Anchored on the whole basename stem on purpose. A substring match would flag
 * `credential.ts` and `token.rs`, which are ordinary program files in this
 * domain, and a silently missing file costs more to a grade than an unread one.
 * `.env`, `id_rsa`, and `*.pem` are covered elsewhere.
 */
const SECRET_NAME_PATTERN =
  /^\.?(secrets?|passwords?|passwd|api[-_]?key|npmrc|pypirc|netrc|htpasswd|id_rsa|id_ed25519|service[-_]?account|aws[-_]?credentials|gcp[-_]?credentials|kubeconfig)([._][a-z0-9]+)?$/i;

const PRIVATE_KEY_SUFFIXES = [".pem", ".key", ".pfx", ".p12", ".kdbx", ".jks"];

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  // No extension (`Makefile`), a dotfile (`.gitignore`), or a trailing dot.
  if (dot <= 0) {
    return "";
  }
  return name.slice(dot + 1).toLowerCase();
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).toLowerCase();
}

/** Lowercase tier index, or `-1` when the extension is not on the allow-list. */
function tierOf(extension: string): number {
  if (extension === "") {
    return -1;
  }
  return EXTENSION_TIERS.findIndex((tier) => tier.includes(extension));
}

function hasIgnoredDirectory(path: string): boolean {
  return path.toLowerCase().split("/").some((segment) => IGNORED_DIRECTORY_SEGMENTS.has(segment));
}

function isIgnoredPath(path: string): boolean {
  const name = baseName(path);
  if (IGNORED_FILE_NAMES.has(name) || hasIgnoredDirectory(path)) {
    return true;
  }
  if (name === ".env" || name.startsWith(".env.")) {
    return true;
  }
  if (SECRET_NAME_PATTERN.test(name)) {
    return true;
  }
  if (IGNORED_NAME_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
    return true;
  }
  return name.endsWith(".lock") || PRIVATE_KEY_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/* ------------------------------------------------------------------ *
 * URL parsing
 * ------------------------------------------------------------------ */

/**
 * `REPO_URL_PATTERN` permits `.` in both segments, so `https://github.com/../..`
 * validates as a submission and must not be handed to a path template. Segments
 * are also length-bounded because they end up in a prompt and in a log line.
 */
const PATH_SEGMENT_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

function isSafeSegment(segment: string): boolean {
  return PATH_SEGMENT_PATTERN.test(segment) && !/^\.+$/.test(segment);
}

export type RepoReference = { owner: string; repo: string };

export type RepoUrlParseResult = { ok: true; data: RepoReference } | { ok: false; error: string };

/**
 * Accepts exactly what `REPO_URL_PATTERN` accepts and nothing more: the pattern is
 * the single source of truth for shape, this function only splits it. A trailing
 * slash is tolerated because `limits.ts` allows one.
 */
export function parseGitHubRepoUrl(repoUrl: string): RepoUrlParseResult {
  const withoutSlash = repoUrl.endsWith("/") ? repoUrl.slice(0, -1) : repoUrl;
  if (!REPO_URL_PATTERN.test(withoutSlash)) {
    return { ok: false, error: "Not a GitHub repository URL of the form https://github.com/owner/repo." };
  }
  let parsed: URL;
  try {
    parsed = new URL(withoutSlash);
  } catch {
    return { ok: false, error: "Not a GitHub repository URL of the form https://github.com/owner/repo." };
  }
  const segments = parsed.pathname.split("/").filter((segment) => segment !== "");
  if (
    parsed.hostname.toLowerCase() !== "github.com" ||
    parsed.protocol !== "https:" ||
    segments.length !== 2 ||
    !isSafeSegment(segments[0] ?? "") ||
    !isSafeSegment(segments[1] ?? "")
  ) {
    return { ok: false, error: "Not a GitHub repository URL of the form https://github.com/owner/repo." };
  }
  const [owner, repo] = segments as [string, string];
  return { ok: true, data: { owner, repo } };
}

/* ------------------------------------------------------------------ *
 * Failure vocabulary
 * ------------------------------------------------------------------ */

/**
 * Stable, machine-readable reasons. A route maps them to status the way
 * `EvaluationErrorCode` is mapped in `app/api/evaluate/route.ts`: NOT_A_REPO_URL
 * 400, NO_TOKEN 503, CREDENTIAL_REJECTED 503, REPO_NOT_FOUND 404, RATE_LIMITED 429,
 * REPO_TOO_LARGE 413, TRANSPORT_ERROR 502.
 */
export type GitHubEvidenceErrorCode =
  | "NOT_A_REPO_URL"
  | "NO_TOKEN"
  | "REPO_NOT_FOUND"
  | "CREDENTIAL_REJECTED"
  | "RATE_LIMITED"
  | "REPO_TOO_LARGE"
  | "TRANSPORT_ERROR";

export type GitHubEvidenceFailure = {
  code: GitHubEvidenceErrorCode;
  /** User-safe. Never contains a token, an upstream body, or upstream error text. */
  message: string;
  retryable: boolean;
  /** Only for RATE_LIMITED, and only when GitHub's own headers stated a delay. */
  retryAfterSeconds?: number;
};

export type RepositoryEvidenceFile = {
  path: string;
  /** Decoded UTF-8 text, exactly as fetched — untrusted, neutralise before prompting. */
  content: string;
  /** Bytes of decoded content, so a budget can be audited without re-encoding. */
  byteLength: number;
  /** The git blob object id from the tree we walked. */
  sha: string;
};

export type RepositoryEvidence = {
  url: string;
  owner: string;
  repo: string;
  /** The ref the tree was walked from — the repository's default branch. */
  ref: string;
  /** Root git tree object id we walked: pins the exact repository state graded. */
  treeOid: string;
  files: RepositoryEvidenceFile[];
  /** Eligible blobs found in the tree, whether or not budget allowed fetching them. */
  candidatesConsidered: number;
  totalBytes: number;
  skipped: { ignored: number; oversize: number; unreadable: number };
  /** Which budget stopped the walk. A `true` flag means the model saw a sample, not the repository. */
  truncated: { files: boolean; bytes: boolean; scan: boolean };
  /** Hex SHA-256 over the canonical manifest; folded into the evidence hash. */
  digest: string;
  fetchedAt: string;
};

export type RepositoryEvidenceResult = { ok: true; data: RepositoryEvidence } | { ok: false; error: GitHubEvidenceFailure };

/* ------------------------------------------------------------------ *
 * Injectable transport
 * ------------------------------------------------------------------ */

export type GitHubTreeEntry = {
  path: string;
  /** Git blob/tree/commit/tag object id. */
  objectId: string;
  /** Git mode: "100644" file, "100755" executable, "120000" symlink, "160000" submodule. */
  mode: string;
  type: string;
  /** Blob size when the API supplied one, which lets the walk skip oversized files unfetched. */
  size?: number;
};

export type GitHubTree = {
  treeOid: string;
  entries: GitHubTreeEntry[];
  /** GitHub's own flag: the entry list is incomplete. Treated as refusal, never as a sample. */
  truncated: boolean;
};

/**
 * The whole network surface of this module, in the shape the walk needs rather
 * than the shape the SDK has, so a stub is three lines and the SDK's response
 * churn stays inside `createOctokitGitHubClient`.
 *
 * Methods may throw — the walk classifies structurally, exactly as
 * `classifyUpstreamError` does for `ChatCompletionClient.create`.
 */
export type GitHubApiClient = {
  /**
   * False when no credential was supplied to the factory. The walk fails closed
   * instead of falling back to anonymous requests, whose 60-requests-per-hour
   * shared budget an attacker could exhaust on their own.
   */
  readonly authenticated: boolean;
  getRepository(owner: string, repo: string): Promise<{ defaultBranch: string }>;
  /** `ref` may be a branch name, a tag, or a commit sha; GitHub resolves it to a tree. */
  getTree(owner: string, repo: string, ref: string): Promise<GitHubTree>;
  /** Base64 blob content, or `null` when GitHub declined to inline it (LFS, too large). */
  getBlob(owner: string, repo: string, sha: string): Promise<string | null>;
};

export type FetchRepositoryEvidenceOptions = {
  client: GitHubApiClient;
  /** Shrink the budgets in tests; production callers leave them at `DEFAULT_LIMITS`. */
  limits?: Partial<RepositoryEvidenceLimits>;
};

/* ------------------------------------------------------------------ *
 * Real transport adapter
 * ------------------------------------------------------------------ */

export type GitHubClientConfig = {
  /** From `GITHUB_TOKEN`; validated by the caller. Never surfaced in a message. */
  token: string | undefined;
  /**
   * Test seam: octokit's own `request.fetch`. Lets the real adapter be driven
   * against its real request/response path without a network, as
   * `openai-client.test.ts` does for the AI SDK.
   */
  fetch?: typeof globalThis.fetch;
  /** Defaults to the public API; a GitHub Enterprise deployment overrides it. */
  baseUrl?: string;
};

/**
 * Maps octokit's response into `GitHubTree`. Entries missing a path or a sha are
 * dropped rather than guessed at: `git get-tree` returns them for pathological
 * objects, and a partial entry cannot be selected or hashed.
 */
export function toGitHubTree(data: {
  sha?: string;
  tree?: { path?: string; mode?: string; type?: string; sha?: string; size?: number }[];
  truncated?: boolean;
}): GitHubTree {
  const entries: GitHubTreeEntry[] = [];
  for (const entry of data.tree ?? []) {
    const { path, sha } = entry;
    if (typeof path !== "string" || typeof sha !== "string" || sha === "") {
      continue;
    }
    const size = typeof entry.size === "number" && Number.isFinite(entry.size) ? entry.size : undefined;
    entries.push({
      path,
      objectId: sha,
      mode: typeof entry.mode === "string" ? entry.mode : "",
      type: typeof entry.type === "string" ? entry.type : "",
      ...(size === undefined ? {} : { size }),
    });
  }
  return { treeOid: data.sha ?? "", entries, truncated: data.truncated === true };
}

/**
 * Builds the real client. No request happens until a method is called and no
 * environment variable is read here: the route passes the token it already
 * validated, which is also the only place the secret is held.
 */
export function createOctokitGitHubClient(config: GitHubClientConfig): GitHubApiClient {
  const token = typeof config.token === "string" ? config.token.trim() : "";
  const octokit = new Octokit({
    ...(token === "" ? {} : { auth: token }),
    baseUrl: config.baseUrl ?? "https://api.github.com",
    ...(config.fetch === undefined ? {} : { request: { fetch: config.fetch } }),
  });

  return {
    authenticated: token !== "",
    async getRepository(owner, repo) {
      const { data } = await octokit.repos.get({ owner, repo });
      return { defaultBranch: data.default_branch };
    },
    async getTree(owner, repo, ref) {
      // `recursive` is typed `string` by octokit 22's generated parameters; "1" is
      // the documented spelling and the one it puts on the query string.
      const { data } = await octokit.git.getTree({ owner, repo, tree_sha: ref, recursive: "1" });
      return toGitHubTree(data);
    },
    async getBlob(owner, repo, sha) {
      const { data } = await octokit.git.getBlob({ owner, repo, file_sha: sha });
      return typeof data.content === "string" ? data.content : null;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Error classification
 * ------------------------------------------------------------------ */

/** `Reflect.get` keeps upstream error inspection cast-free, as in `upstream-error.ts`. */
function readProperty(error: unknown, key: string): unknown {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  return Reflect.get(error, key);
}

/**
 * Header lookup that accepts both shapes a transport may hand us: octokit's plain
 * lowercase-keyed object, and a WHATWG `Headers`. Values are trimmed and empty
 * strings become `undefined`.
 */
function headerValue(error: unknown, name: string): string | undefined {
  const headers = readProperty(error, "headers") ?? readProperty(readProperty(error, "response"), "headers");
  if (typeof headers !== "object" || headers === null) {
    return undefined;
  }
  const candidates = [Reflect.get(headers, name), Reflect.get(headers, name.toLowerCase())];
  const getter = Reflect.get(headers, "get");
  if (typeof getter === "function") {
    candidates.push(Reflect.apply(getter as (...args: unknown[]) => unknown, headers, [name]));
  }
  for (const value of candidates) {
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return undefined;
}

function positiveSeconds(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.ceil(parsed) : undefined;
}

function statusOf(error: unknown): number | undefined {
  const status = readProperty(error, "status");
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

function failure(
  code: GitHubEvidenceErrorCode,
  message: string,
  retryable: boolean,
  retryAfterSeconds?: number,
): GitHubEvidenceFailure {
  return retryAfterSeconds === undefined ? { code, message, retryable } : { code, message, retryable, retryAfterSeconds };
}

/**
 * GitHub's primary rate limit arrives as 403 with `x-ratelimit-remaining: 0` and
 * no `Retry-After`, so the reset timestamp is the only delay available; secondary
 * limits and abuse detection answer 429/403 with `Retry-After`. `nowMs` is a
 * parameter, not a read of the clock inside the decision, so tests are exact.
 */
export function classifyGitHubError(error: unknown, options: { nowMs?: number } = {}): GitHubEvidenceFailure {
  const status = statusOf(error);
  const retryAfter = positiveSeconds(headerValue(error, "retry-after"));
  const remaining = headerValue(error, "x-ratelimit-remaining");
  const resetAt = positiveSeconds(headerValue(error, "x-ratelimit-reset"));

  if (status === 404) {
    // Private, renamed, deleted, or never existed — GitHub answers all of them
    // with 404 precisely so existence cannot be probed, so we repeat the same
    // ambiguity instead of guessing which one it was.
    return failure(
      "REPO_NOT_FOUND",
      "That repository could not be read. It may be private, renamed, or deleted.",
      false,
    );
  }

  const rateLimited = status === 429 || (status === 403 && (remaining === "0" || retryAfter !== undefined));
  if (rateLimited) {
    let seconds = retryAfter;
    if (seconds === undefined && resetAt !== undefined) {
      const nowMs = options.nowMs ?? Date.now();
      seconds = Math.min(3600, Math.max(1, Math.ceil((resetAt * 1000 - nowMs) / 1000)));
    }
    return failure(
      "RATE_LIMITED",
      "GitHub is rate limiting repository reads. Please try again shortly.",
      true,
      seconds,
    );
  }

  if (status === 401 || status === 403) {
    // Not a rate limit: the credential is wrong, or the account behind it cannot
    // see this repository. Both are deployment problems, not candidate problems.
    return failure(
      "CREDENTIAL_REJECTED",
      "GitHub refused the configured GITHUB_TOKEN for this repository (HTTP " + String(status) + ").",
      false,
    );
  }

  if (status !== undefined) {
    return failure("TRANSPORT_ERROR", `Reading the repository failed (HTTP ${String(status)}).`, status >= 500);
  }

  return failure("TRANSPORT_ERROR", "Could not reach GitHub to read the repository.", true);
}

/* ------------------------------------------------------------------ *
 * Decoding
 * ------------------------------------------------------------------ */

/** Strict decode: a repository file that is not valid UTF-8 is not source text. */
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

/** Base64 as GitHub returns it (with optional line breaks) to bytes, or undefined if malformed. */
function base64ToBytes(base64: string): Uint8Array | undefined {
  const compact = base64.replace(/\s+/g, "");
  if (compact === "" || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    return undefined;
  }
  try {
    const binary = atob(compact);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    // `atob` rejects padding it cannot use; that is a non-text blob, not a crash.
    return undefined;
  }
}

/**
 * Bytes of a base64 encoding of `byteLength` bytes, so a blob too large to be
 * admitted can be refused before it is decoded.
 */
function base64LengthFor(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

/* ------------------------------------------------------------------ *
 * Selection and hashing
 * ------------------------------------------------------------------ */

export type Candidate = { path: string; sha: string; size?: number; tier: number };

/** Eligible blobs plus the count of blobs the rules refused, so "ignored" is never re-derived by a second filter. */
export type CandidateScan = { candidates: Candidate[]; ignored: number };

/**
 * Eligible blobs, ordered by tier then path. Comparison is by code point rather
 * than `localeCompare` so the selection is the same on every host locale — the
 * digest depends on it.
 */
export function selectCandidates(entries: readonly GitHubTreeEntry[], limits: RepositoryEvidenceLimits): CandidateScan {
  const candidates: Candidate[] = [];
  let ignored = 0;
  for (const entry of entries) {
    if (entry.type !== "blob") {
      continue;
    }
    // Only regular files. `120000` is a symlink (its blob is the target path, not
    // content) and `160000`/`commit`/`tag` are submodules — a pointer into a
    // second repository we have not audited and will not fetch.
    const regularFile = entry.mode === "100644" || entry.mode === "100755";
    const tier = tierOf(extensionOf(entry.path));
    if (!regularFile || tier < 0 || isIgnoredPath(entry.path)) {
      ignored += 1;
      continue;
    }
    // Refused on size here rather than counted as `oversize` later: the walk never
    // sees these, and a tree entry that reports its size costs no blob fetch.
    if (entry.size !== undefined && entry.size >= limits.maxFileBytes) {
      ignored += 1;
      continue;
    }
    candidates.push({ path: entry.path, sha: entry.objectId, ...(entry.size === undefined ? {} : { size: entry.size }), tier });
  }
  candidates.sort((a, b) => a.tier - b.tier || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { candidates, ignored };
}

/**
 * Canonical manifest for the digest: the ref and tree we walked, and the exact
 * path/blob-sha pairs handed to the model. `fetchedAt`, file contents, and the
 * skip counters are excluded deliberately — two evaluations of the same commit
 * must produce the same digest, while a different subset of files must not.
 */
export function canonicalEvidenceManifest(
  evidence: Pick<RepositoryEvidence, "owner" | "repo" | "ref" | "treeOid" | "files">,
): string {
  return JSON.stringify({
    owner: evidence.owner,
    ref: evidence.ref,
    repo: evidence.repo,
    files: evidence.files.map((file) => ({ bytes: file.byteLength, path: file.path, sha: file.sha })),
    treeOid: evidence.treeOid,
  });
}

export async function repositoryEvidenceDigest(
  evidence: Pick<RepositoryEvidence, "owner" | "repo" | "ref" | "treeOid" | "files">,
): Promise<string> {
  return sha256Hex(canonicalEvidenceManifest(evidence));
}

/* ------------------------------------------------------------------ *
 * The walk
 * ------------------------------------------------------------------ */

function notARepoUrl(message: string): RepositoryEvidenceResult {
  return { ok: false, error: failure("NOT_A_REPO_URL", message, false) };
}

/**
 * Fetches a bounded sample of a candidate's repository. Fails closed: any
 * transport error, a truncated tree, or an over-large entry list returns a typed
 * failure rather than a partial sample, because a credential must not be minted
 * on half a repository. The caller may still evaluate the submission without
 * evidence — that is the route's choice, not this module's.
 */
export async function fetchRepositoryEvidence(
  repoUrl: string,
  options: FetchRepositoryEvidenceOptions,
): Promise<RepositoryEvidenceResult> {
  const limits: RepositoryEvidenceLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const { client } = options;

  const reference = parseGitHubRepoUrl(repoUrl);
  if (!reference.ok) {
    return notARepoUrl(reference.error);
  }
  const { owner, repo } = reference.data;

  if (!client.authenticated) {
    return {
      ok: false,
      error: failure("NO_TOKEN", "No GitHub token is configured, so the repository could not be read.", false),
    };
  }

  let ref: string;
  let tree: GitHubTree;
  try {
    ref = (await client.getRepository(owner, repo)).defaultBranch;
    tree = await client.getTree(owner, repo, ref);
  } catch (error) {
    return { ok: false, error: classifyGitHubError(error) };
  }

  if (ref.trim() === "" || tree.treeOid.trim() === "") {
    return { ok: false, error: failure("REPO_NOT_FOUND", "That repository has no readable default branch.", false) };
  }
  // `truncated: true` means the entry list GitHub returned is not the whole tree.
  // Walking it anyway would let a candidate hide files past the cut, so it is a
  // refusal, not a warning.
  if (tree.truncated || tree.entries.length > limits.maxTreeEntries) {
    return {
      ok: false,
      error: failure(
        "REPO_TOO_LARGE",
        "That repository is too large to grade from GitHub. Push a smaller, focused repository.",
        false,
      ),
    };
  }

  const scan = selectCandidates(tree.entries, limits);
  const candidates = scan.candidates;
  const files: RepositoryEvidenceFile[] = [];
  const skipped = { ignored: scan.ignored, oversize: 0, unreadable: 0 };
  const truncated = { files: false, bytes: false, scan: false };
  let totalBytes = 0;
  let blobFetches = 0;
  // A file dropped because it did not fit the *remaining* budget is byte-budget
  // truncation even when the walk ran to the end of the candidate list.
  let byteBudgetDroppedOne = false;

  for (const candidate of candidates) {
    if (files.length >= limits.maxFiles) {
      truncated.files = true;
      break;
    }
    const remaining = limits.maxTotalBytes - totalBytes;
    if (remaining <= 0) {
      truncated.bytes = true;
      break;
    }
    // A tree entry that already reports a size can be refused without spending a
    // blob fetch on it. It counts as byte-budget truncation, not as an ignored
    // file: the repository did have source there, and the model did not see it.
    if (candidate.size !== undefined && candidate.size > remaining) {
      skipped.oversize += 1;
      byteBudgetDroppedOne = true;
      continue;
    }
    if (blobFetches >= limits.maxBlobFetches) {
      truncated.scan = true;
      break;
    }
    blobFetches += 1;

    let base64: string | null;
    try {
      base64 = await client.getBlob(owner, repo, candidate.sha);
    } catch (error) {
      return { ok: false, error: classifyGitHubError(error) };
    }

    if (base64 === null) {
      // LFS pointers and blobs GitHub declined to inline: no content to grade.
      skipped.unreadable += 1;
      continue;
    }
    // Refuse on the encoded length before decoding: GitHub's blob endpoint caps
    // at 100 MB and would otherwise have us allocate that as a string. This is an
    // allocation guard, not the cap itself — rounding leaves it up to 3 bytes
    // short, so the decoded length is checked below.
    if (base64.length > base64LengthFor(limits.maxFileBytes)) {
      skipped.oversize += 1;
      continue;
    }
    const bytes = base64ToBytes(base64);
    if (bytes === undefined) {
      skipped.unreadable += 1;
      continue;
    }
    // Same "at or above the cap" rule as the tree-size check, so a blob whose size
    // the tree did not report cannot slip past `maxFileBytes`.
    if (bytes.byteLength >= limits.maxFileBytes) {
      skipped.oversize += 1;
      continue;
    }
    if (bytes.byteLength > remaining) {
      skipped.oversize += 1;
      byteBudgetDroppedOne = true;
      continue;
    }
    // A NUL byte is binary content wearing an allowed extension — the allow-list
    // is the first guard, this is the second.
    if (bytes.includes(0)) {
      skipped.unreadable += 1;
      continue;
    }
    let content: string;
    try {
      content = STRICT_UTF8.decode(bytes);
    } catch {
      skipped.unreadable += 1;
      continue;
    }
    if (content === "") {
      continue;
    }

    files.push({ path: candidate.path, content, byteLength: bytes.byteLength, sha: candidate.sha });
    totalBytes += bytes.byteLength;
  }

  if (byteBudgetDroppedOne) {
    truncated.bytes = true;
  }

  const base = { owner, repo, ref, treeOid: tree.treeOid, files };
  const digest = await repositoryEvidenceDigest(base);

  return {
    ok: true,
    data: {
      url: repoUrl,
      ...base,
      candidatesConsidered: candidates.length,
      totalBytes,
      skipped,
      truncated,
      digest,
      fetchedAt: new Date().toISOString(),
    },
  };
}
