import { describe, expect, it, vi } from "vitest";

// `server-only` throws when imported outside a React Server bundler, so vitest
// needs the stub hoisted above the imports (docs/living-notes.md → frontend).
vi.mock("server-only", () => ({ default: {} }));

import {
  DEFAULT_LIMITS,
  classifyGitHubError,
  createOctokitGitHubClient,
  fetchRepositoryEvidence,
  parseGitHubRepoUrl,
  repositoryEvidenceDigest,
  selectCandidates,
  toGitHubTree,
  type GitHubApiClient,
  type GitHubTreeEntry,
} from "./github";

/**
 * Every refusal, budget, and decode case runs against a stub client: no socket, no
 * token, no network. Only the `createOctokitGitHubClient` block touches the real
 * SDK, and it does so through octokit's own `request.fetch` seam — the same
 * approach `openai-client.test.ts` uses.
 */

const REPO_URL = "https://github.com/acme/skill-proof";

type Fixture = { path: string; sha: string; size?: number; mode?: string; type?: string };

function treeEntries(files: readonly Fixture[]): GitHubTreeEntry[] {
  return files.map((file) => ({
    path: file.path,
    objectId: file.sha,
    mode: file.mode ?? "100644",
    type: file.type ?? "blob",
    ...(file.size === undefined ? {} : { size: file.size }),
  }));
}

function toBase64(text: string): string {
  return btoa(text);
}

type StubSpec = {
  authenticated?: boolean;
  defaultBranch?: string;
  entries?: GitHubTreeEntry[];
  treeOid?: string;
  treeTruncated?: boolean;
  /** blob sha -> base64 payload, `null` for "GitHub declined to inline it", or an Error to reject with. */
  blobs?: Record<string, string | null | Error>;
};

type Stub = GitHubApiClient & {
  readonly calls: string[];
  readonly blobShas: string[];
};

function stubClient(spec: StubSpec = {}): Stub {
  const calls: string[] = [];
  const blobShas: string[] = [];
  const entries = spec.entries ?? [];
  return {
    calls,
    blobShas,
    authenticated: spec.authenticated ?? true,
    getRepository(owner, repo) {
      calls.push(`repo:${owner}/${repo}`);
      return Promise.resolve({ defaultBranch: spec.defaultBranch ?? "main" });
    },
    getTree(owner, repo, ref) {
      calls.push(`tree:${owner}/${repo}@${ref}`);
      return Promise.resolve({
        treeOid: spec.treeOid ?? "tree-oid-0001",
        entries,
        truncated: spec.treeTruncated === true,
      });
    },
    getBlob(owner, repo, sha) {
      calls.push(`blob:${sha}`);
      blobShas.push(sha);
      const blob = spec.blobs?.[sha];
      if (blob instanceof Error) {
        return Promise.reject(blob);
      }
      return Promise.resolve(blob === undefined ? "" : blob);
    },
  };
}

/** Text files as a stub: path -> content, blob sha derived from the path, size from the encoded bytes. */
function textRepo(files: Record<string, string>, extra: StubSpec = {}): Stub {
  const paths = Object.keys(files);
  return stubClient({
    ...extra,
    entries: treeEntries(
      paths.map((path) => ({
        path,
        sha: `sha-${path}`,
        size: new TextEncoder().encode(files[path] ?? "").length,
      })),
    ),
    blobs: Object.fromEntries(paths.map((path) => [`sha-${path}`, toBase64(files[path] ?? "")])),
  });
}

function httpError(status: number, headers: Record<string, string> = {}): Error {
  return Object.assign(new Error(`HTTP ${status} upstream body that must never be echoed`), { status, headers });
}

describe("parseGitHubRepoUrl", () => {
  it("accepts the shapes the submission schema allows", () => {
    for (const url of [
      "https://github.com/acme/skill-proof",
      "https://github.com/acme/skill-proof/",
      "https://github.com/Dell-9/proofofskill.dev",
      "https://github.com/a/b",
    ]) {
      const result = parseGitHubRepoUrl(url);
      expect(result.ok, url).toBe(true);
    }
    expect(parseGitHubRepoUrl("https://github.com/acme/skill-proof/")).toEqual({ ok: true, data: { owner: "acme", repo: "skill-proof" } });
  });

  it("rejects everything else, including the traversal the pattern itself lets through", () => {
    const rejected = [
      "http://github.com/acme/repo",
      "https://gitlab.com/acme/repo",
      "https://github.com/acme",
      "https://github.com/acme/repo/extra",
      "https://github.com/acme/repo/blob/main/src/lib.rs",
      "https://github.com/../..",
      "https://github.com/../../etc",
      "https://github.com./evil/repo",
      "https://github.com/acme/repo?token=secret",
      "https://github.com/acme/repo#frag",
      "https://evil.com/github.com/acme/repo",
      "github.com/acme/repo",
      "",
      "  https://github.com/acme/repo",
    ];
    for (const url of rejected) {
      const result = parseGitHubRepoUrl(url);
      expect(result.ok, `expected rejection for ${JSON.stringify(url)}`).toBe(false);
    }
  });

  it("refuses dot-only and empty segments rather than passing them to a path template", () => {
    expect(parseGitHubRepoUrl("https://github.com/./repo").ok).toBe(false);
    expect(parseGitHubRepoUrl("https://github.com/owner/...").ok).toBe(false);
    expect(parseGitHubRepoUrl("https://github.com/..").ok).toBe(false);
  });
});

describe("fetchRepositoryEvidence: refusals before any network call", () => {
  it("returns NOT_A_REPO_URL without touching the client", async () => {
    const client = stubClient();
    const result = await fetchRepositoryEvidence("https://evil.example/x/y", { client });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_A_REPO_URL");
      expect(result.error.retryable).toBe(false);
    }
    expect(client.calls).toEqual([]);
  });

  it("returns NO_TOKEN when the client holds no credential, and never calls it", async () => {
    const client = stubClient({ authenticated: false });
    const result = await fetchRepositoryEvidence(REPO_URL, { client });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NO_TOKEN");
      expect(result.error.retryable).toBe(false);
      expect(result.error.message).not.toMatch(/ghp_|Bearer/);
    }
    expect(client.calls).toEqual([]);
  });
});

describe("fetchRepositoryEvidence: the walk", () => {
  it("reports the ref, the tree it walked, and each file with its blob sha", async () => {
    const client = stubClient({
      defaultBranch: "trunk",
      treeOid: "8f3ab1c",
      entries: [
        ...treeEntries([
          { path: "src/lib.rs", sha: "b1" },
          { path: "src/main.rs", sha: "b2" },
          { path: "src", sha: "t1", mode: "040000", type: "tree" },
        ]),
      ],
      blobs: { b1: toBase64("fn main() {}"), b2: toBase64("mod lib;") },
    });
    const result = await fetchRepositoryEvidence(REPO_URL, { client });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data).toMatchObject({
      url: REPO_URL,
      owner: "acme",
      repo: "skill-proof",
      ref: "trunk",
      treeOid: "8f3ab1c",
      totalBytes: 20,
      candidatesConsidered: 2,
      skipped: { ignored: 0, oversize: 0, unreadable: 0 },
      truncated: { files: false, bytes: false, scan: false },
    });
    expect(result.data.files).toEqual([
      { path: "src/lib.rs", content: "fn main() {}", byteLength: 12, sha: "b1" },
      { path: "src/main.rs", content: "mod lib;", byteLength: 8, sha: "b2" },
    ]);
    expect(result.data.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(result.data.fetchedAt)).not.toBeNaN();
    expect(client.calls).toEqual(["repo:acme/skill-proof", "tree:acme/skill-proof@trunk", "blob:b1", "blob:b2"]);
  });

  it("walks the repository default branch, not a branch name from the URL", async () => {
    const client = stubClient({ defaultBranch: "develop", blobs: {} });
    await expect(fetchRepositoryEvidence(REPO_URL, { client })).resolves.toMatchObject({ ok: true });
    expect(client.calls[1]).toBe("tree:acme/skill-proof@develop");
  });

  it("selects implementation files ahead of documentation and flags the file budget", async () => {
    const result = await fetchRepositoryEvidence(REPO_URL, {
      client: textRepo({ "README.md": "docs", "src/lib.rs": "code" }),
      limits: { maxFiles: 1 },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.files.map((file) => file.path)).toEqual(["src/lib.rs"]);
      expect(result.data.truncated.files).toBe(true);
      expect(result.data.truncated.bytes).toBe(false);
    }
  });

  it("an empty selection is still a result, with a digest of the tree it walked", async () => {
    const result = await fetchRepositoryEvidence(REPO_URL, {
      client: stubClient({ entries: treeEntries([{ path: "assets/logo.png", sha: "x", size: 10 }]) }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.files).toEqual([]);
      expect(result.data.digest).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe("fetchRepositoryEvidence: file selection rules", () => {
  it("refuses a blob at or above the per-file byte cap without fetching it", async () => {
    const client = stubClient({
      entries: treeEntries([
        { path: "big.rs", sha: "big", size: 500 },
        { path: "small.rs", sha: "small", size: 10 },
      ]),
      blobs: { small: toBase64("tiny file") },
    });
    const result = await fetchRepositoryEvidence(REPO_URL, { client, limits: { maxFileBytes: 500 } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.files.map((file) => file.path)).toEqual(["small.rs"]);
      expect(result.data.skipped.ignored).toBe(1);
    }
    expect(client.blobShas).toEqual(["small"]);
  });

  it("enforces the total byte ceiling and flags it", async () => {
    const client = textRepo({ "a.rs": "x".repeat(40), "b.rs": "y".repeat(40), "c.rs": "z" });
    const result = await fetchRepositoryEvidence(REPO_URL, { client, limits: { maxTotalBytes: 60 } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.totalBytes).toBeLessThanOrEqual(60);
      // b.rs does not fit what a.rs left, c.rs does: the walk skips rather than stops.
      expect(result.data.files.map((file) => file.path)).toEqual(["a.rs", "c.rs"]);
      expect(result.data.truncated.bytes).toBe(true);
      expect(result.data.skipped.oversize).toBe(1);
    }
  });

  it("caps the file count", async () => {
    const result = await fetchRepositoryEvidence(REPO_URL, {
      client: textRepo({ "a.rs": "x", "b.rs": "y", "c.rs": "z", "d.rs": "w" }),
      limits: { maxFiles: 2 },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.files).toHaveLength(2);
      expect(result.data.truncated.files).toBe(true);
      expect(result.data.candidatesConsidered).toBe(4);
    }
  });

  it("caps blob fetches so an unreadable repo cannot spend unbounded API calls", async () => {
    const client = stubClient({
      entries: treeEntries(Array.from({ length: 10 }, (_unused, index) => ({ path: `f${index}.rs`, sha: `sha${index}` }))),
    });
    const result = await fetchRepositoryEvidence(REPO_URL, { client, limits: { maxBlobFetches: 3, maxFiles: 10 } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(client.blobShas).toHaveLength(3);
      expect(result.data.truncated.scan).toBe(true);
    }
  });

  it("ignores non-source extensions, lockfiles, vendored dirs, generated output, and secret-looking names", async () => {
    const ignoredPaths = [
      "dist/bundle.rs",
      "node_modules/dep/index.js",
      "vendor/lib.go",
      ".github/workflows/ci.yml",
      "src/lib.generated.rs",
      "src/app.min.js",
      "src/types.d.ts",
      "Cargo.lock",
      "package-lock.json",
      "src/.env",
      "config/production.env",
      "keys/id_rsa",
      "src/service-account.json",
      "secrets/token.txt",
      "assets/logo.png",
      "Makefile",
    ];
    const client = stubClient({ entries: treeEntries(ignoredPaths.map((path) => ({ path, sha: `sha-${path}`, size: 10 }))) });
    const result = await fetchRepositoryEvidence(REPO_URL, { client });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.skipped.ignored, `survivors: ${JSON.stringify(result.data.files)}`).toBe(ignoredPaths.length);
      expect(result.data.files).toEqual([]);
    }
    expect(client.blobShas).toEqual([]);
  });

  it("does not mistake ordinary source names for secrets", async () => {
    const kept = ["src/session.rs", "src/pda.rs", "package.json", "Cargo.toml", "README.md", "contracts/credential.ts"];
    const result = await fetchRepositoryEvidence(REPO_URL, {
      client: textRepo(Object.fromEntries(kept.map((path) => [path, "x"]))),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.files.map((file) => file.path).sort()).toEqual([...kept].sort());
      expect(result.data.truncated).toEqual({ files: false, bytes: false, scan: false });
    }
  });

  it("never follows symlinks or submodule pointers", async () => {
    const client = stubClient({
      entries: treeEntries([
        { path: "passwd-link.rs", sha: "s1", size: 11, mode: "120000" },
        { path: "other-repo", sha: "s2", size: 0, mode: "160000", type: "commit" },
        { path: "real.rs", sha: "s3", size: 4, mode: "100755" },
      ]),
      blobs: { s1: toBase64("/etc/passwd"), s2: toBase64("deadbeef"), s3: toBase64("code") },
    });
    const result = await fetchRepositoryEvidence(REPO_URL, { client });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.files.map((file) => file.path)).toEqual(["real.rs"]);
    }
    expect(client.blobShas).toEqual(["s3"]);
  });

  it("skips a binary blob, a blob that is not valid UTF-8, and one GitHub declined to inline", async () => {
    const client = stubClient({
      entries: treeEntries([
        { path: "text.rs", sha: "t" },
        { path: "binary.rs", sha: "bin" },
        { path: "latin.rs", sha: "l" },
        { path: "pointer.rs", sha: "p" },
      ]),
      blobs: {
        t: toBase64("fn main() {}"),
        bin: toBase64("PK\u0000\u0001zip"),
        // 0xDE 0xAD is a valid pair, 0xBF 0xBE is not a sequence at all.
        l: "3q2+7w==",
        p: null,
      },
    });
    const result = await fetchRepositoryEvidence(REPO_URL, { client });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.files.map((file) => file.path)).toEqual(["text.rs"]);
      expect(result.data.skipped.unreadable).toBe(3);
    }
  });

  it("applies the per-file cap to the decoded length when the tree reported no size", async () => {
    const cap = 100;
    const client = stubClient({
      entries: treeEntries([{ path: "at-cap.rs", sha: "at" }, { path: "under-cap.rs", sha: "under" }]),
      blobs: { at: toBase64("x".repeat(cap)), under: toBase64("y".repeat(cap - 1)) },
    });
    const result = await fetchRepositoryEvidence(REPO_URL, {
      client,
      limits: { maxFileBytes: cap, maxTotalBytes: 10_000 },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.files.map((file) => file.path)).toEqual(["under-cap.rs"]);
      expect(result.data.skipped.oversize).toBe(1);
      // Budget truncation, not a refusal: the walk kept going and found a usable file.
      expect(result.data.truncated.bytes).toBe(false);
    }
  });

  it("refuses a blob whose encoding is larger than the per-file cap before decoding it", async () => {
    const client = stubClient({
      entries: treeEntries([{ path: "huge.rs", sha: "h" }]),
      blobs: { h: "A".repeat(4_000) },
    });
    const result = await fetchRepositoryEvidence(REPO_URL, { client, limits: { maxFileBytes: 1_000 } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.files).toEqual([]);
      expect(result.data.skipped.oversize).toBe(1);
    }
  });

  it("treats malformed base64 as unreadable instead of throwing", async () => {
    const client = stubClient({ entries: treeEntries([{ path: "junk.rs", sha: "j" }]), blobs: { j: "not base64 !!!" } });
    const result = await fetchRepositoryEvidence(REPO_URL, { client });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.skipped.unreadable).toBe(1);
    }
  });
});

describe("fetchRepositoryEvidence: tree size guards", () => {
  it("refuses a truncated recursive tree rather than grading a partial repo", async () => {
    const result = await fetchRepositoryEvidence(REPO_URL, {
      client: stubClient({ entries: treeEntries([{ path: "a.rs", sha: "a", size: 1 }]), treeTruncated: true }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("REPO_TOO_LARGE");
      expect(result.error.retryable).toBe(false);
    }
  });

  it("refuses a tree with more entries than the walk will inspect", async () => {
    const result = await fetchRepositoryEvidence(REPO_URL, {
      client: stubClient({ entries: treeEntries(Array.from({ length: 4 }, (_u, i) => ({ path: `f${i}.rs`, sha: `s${i}` }))) }),
      limits: { maxTreeEntries: 3 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("REPO_TOO_LARGE");
    }
  });

  it("refuses a repository with no readable default branch or root tree", async () => {
    for (const spec of [{ defaultBranch: "  " }, { treeOid: "" }]) {
      const result = await fetchRepositoryEvidence(REPO_URL, { client: stubClient(spec) });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("REPO_NOT_FOUND");
      }
    }
  });
});

describe("failure reasons are values, mapped from whatever the transport threw", () => {
  it("maps a 404 to REPO_NOT_FOUND without saying which reason it was", async () => {
    const client = stubClient({ entries: treeEntries([{ path: "a.rs", sha: "a" }]) });
    client.getRepository = () => Promise.reject(httpError(404));
    const result = await fetchRepositoryEvidence(REPO_URL, { client });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("REPO_NOT_FOUND");
      expect(result.error.retryable).toBe(false);
      expect(result.error.message).toMatch(/private, renamed, or deleted/);
      expect(result.error.message).not.toMatch(/upstream body|404/);
    }
  });

  it("maps a secondary rate limit (429 with Retry-After) and surfaces the delay", async () => {
    const client = stubClient({ entries: treeEntries([{ path: "a.rs", sha: "a" }]) });
    client.getTree = () => Promise.reject(httpError(429, { "retry-after": "7" }));
    const result = await fetchRepositoryEvidence(REPO_URL, { client });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("RATE_LIMITED");
      expect(result.error.retryable).toBe(true);
      expect(result.error.retryAfterSeconds).toBe(7);
    }
  });

  it("maps a primary rate limit (403, x-ratelimit-remaining: 0) to a delay derived from the reset epoch", () => {
    const error = classifyGitHubError(httpError(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "100" }), {
      nowMs: 0,
    });
    expect(error).toEqual({ code: "RATE_LIMITED", message: expect.any(String), retryable: true, retryAfterSeconds: 100 });
  });

  it("clamps a far-future reset instead of promising an absurd wait", () => {
    const error = classifyGitHubError(httpError(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "999999999" }), {
      nowMs: 0,
    });
    expect(error.retryAfterSeconds).toBe(3600);
  });

  it("maps a bare 403 to CREDENTIAL_REJECTED and never calls it a rate limit", () => {
    const error = classifyGitHubError(httpError(403, {}), { nowMs: 0 });
    expect(error.code).toBe("CREDENTIAL_REJECTED");
    expect(error.retryable).toBe(false);
    expect(error.retryAfterSeconds).toBeUndefined();
  });

  it("maps a 401 to CREDENTIAL_REJECTED", () => {
    expect(classifyGitHubError(httpError(401), { nowMs: 0 }).code).toBe("CREDENTIAL_REJECTED");
  });

  it("maps a 5xx to a retryable TRANSPORT_ERROR, a 4xx to a terminal one, and a bare failure to retryable", () => {
    expect(classifyGitHubError(httpError(503), { nowMs: 0 })).toMatchObject({ code: "TRANSPORT_ERROR", retryable: true });
    expect(classifyGitHubError(httpError(400), { nowMs: 0 })).toMatchObject({ code: "TRANSPORT_ERROR", retryable: false });
    expect(classifyGitHubError(Object.assign(new Error("fetch failed"), { name: "TypeError" }), { nowMs: 0 })).toMatchObject({
      code: "TRANSPORT_ERROR",
      retryable: true,
    });
    expect(classifyGitHubError("a string", { nowMs: 0 }).code).toBe("TRANSPORT_ERROR");
  });

  it("reads headers from a WHATWG Headers object as well as a plain record", () => {
    const withHeaders = Object.assign(new Error("limited"), {
      status: 429,
      response: { headers: new Headers({ "retry-after": "12" }) },
    });
    expect(classifyGitHubError(withHeaders, { nowMs: 0 })).toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: 12 });
  });

  it("fails closed when one blob cannot be read, rather than grading half a repo", async () => {
    const client = stubClient({
      entries: treeEntries([
        { path: "a.rs", sha: "a" },
        { path: "b.rs", sha: "b" },
      ]),
      blobs: { a: toBase64("first"), b: httpError(404) },
    });
    const result = await fetchRepositoryEvidence(REPO_URL, { client });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("REPO_NOT_FOUND");
    }
  });

  it("never echoes the upstream message or a token into a returned string", async () => {
    const secret = "ghp_SUPERSecretValue_123";
    const client = stubClient({ entries: treeEntries([{ path: "a.rs", sha: "a" }]) });
    client.getRepository = () => Promise.reject(Object.assign(new Error(`bad token ${secret}`), { status: 401 }));
    const result = await fetchRepositoryEvidence(REPO_URL, { client });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("bad token");
  });
});

describe("toGitHubTree and selectCandidates", () => {
  it("drops tree entries that carry no path or no object id", () => {
    const tree = toGitHubTree({
      sha: "root",
      truncated: false,
      tree: [{ path: "a.rs", sha: "1" }, { sha: "2" }, { path: "b.rs" }, {}],
    });
    expect(tree.entries.map((entry) => entry.path)).toEqual(["a.rs"]);
    expect(tree.treeOid).toBe("root");
  });

  it("treats a missing sha or truncated flag as absent, not as truthy", () => {
    expect(toGitHubTree({ tree: [] })).toEqual({ treeOid: "", entries: [], truncated: false });
  });

  it("orders by tier, then by code point rather than locale", () => {
    const scan = selectCandidates(
      treeEntries([
        { path: "Zebra.md", sha: "z" },
        { path: "apple.rs", sha: "a" },
        { path: "Banana.rs", sha: "b" },
        { path: "cargo.toml", sha: "c" },
      ]),
      DEFAULT_LIMITS,
    );
    expect(scan.candidates.map((candidate) => candidate.path)).toEqual(["Banana.rs", "apple.rs", "cargo.toml", "Zebra.md"]);
  });

  it("is unchanged when the entry order is shuffled", () => {
    const entries = treeEntries([
      { path: "src/a.rs", sha: "1" },
      { path: "src/b.rs", sha: "2" },
      { path: "docs/readme.md", sha: "3" },
    ]);
    const forward = selectCandidates(entries, DEFAULT_LIMITS).candidates.map((candidate) => candidate.path);
    const backward = selectCandidates([...entries].reverse(), DEFAULT_LIMITS).candidates.map((candidate) => candidate.path);
    expect(forward).toEqual(backward);
  });
});

describe("repositoryEvidenceDigest", () => {
  const evidence = {
    owner: "acme",
    repo: "skill-proof",
    ref: "main",
    treeOid: "tree-1",
    files: [{ path: "a.rs", content: "one", byteLength: 3, sha: "b1" }],
  };

  it("ignores content and fetch time, so the same commit always hashes alike", async () => {
    const first = await repositoryEvidenceDigest(evidence);
    const second = await repositoryEvidenceDigest({ ...evidence, files: [{ ...evidence.files[0], content: "different bytes" }] });
    expect(first).toBe(second);
  });

  it("changes when the tree oid changes", async () => {
    expect(await repositoryEvidenceDigest({ ...evidence, treeOid: "tree-2" })).not.toBe(await repositoryEvidenceDigest(evidence));
  });

  it("changes when the selected subset changes, even for the same tree", async () => {
    const base = await repositoryEvidenceDigest(evidence);
    const extraFile = await repositoryEvidenceDigest({
      ...evidence,
      files: [...evidence.files, { path: "b.rs", content: "x", byteLength: 1, sha: "b2" }],
    });
    const differentBlob = await repositoryEvidenceDigest({ ...evidence, files: [{ ...evidence.files[0], sha: "b9" }] });
    expect(extraFile).not.toBe(base);
    expect(differentBlob).not.toBe(base);
  });

  it("matches the digest the walk reports for the same state", async () => {
    const result = await fetchRepositoryEvidence(REPO_URL, { client: textRepo({ "src/lib.rs": "fn main() {}" }) });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.digest).toBe(
      await repositoryEvidenceDigest({
        owner: "acme",
        repo: "skill-proof",
        ref: "main",
        treeOid: "tree-oid-0001",
        files: result.data.files,
      }),
    );
  });

  it("two walks of the same repository produce the same digest", async () => {
    const build = () => fetchRepositoryEvidence(REPO_URL, { client: textRepo({ "a.rs": "one", "b.rs": "two" }) });
    const first = await build();
    const second = await build();
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.data.digest).toBe(second.data.digest);
    }
  });
});

describe("createOctokitGitHubClient", () => {
  type Captured = { urls: string[]; authorizations: (string | null)[] };

  function capture(): Captured {
    return { urls: [], authorizations: [] };
  }

  /**
   * Octokit's own `request.fetch` seam: the SDK builds the real request, so these
   * assertions are about paths and payload mapping, not about a hand-written mock.
   */
  function clientWith(seen: Captured, respond: (url: string) => Response, token = "ghp_test") {
    return createOctokitGitHubClient({
      token,
      baseUrl: "https://github.example.invalid/api/v3",
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : String(input);
        seen.urls.push(url);
        seen.authorizations.push(new Headers(init?.headers).get("authorization"));
        return respond(url);
      },
    });
  }

  function json(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }

  it("reports itself authenticated only when a usable token was supplied", () => {
    expect(createOctokitGitHubClient({ token: "  " }).authenticated).toBe(false);
    expect(createOctokitGitHubClient({ token: undefined }).authenticated).toBe(false);
    expect(createOctokitGitHubClient({ token: "ghp_x" }).authenticated).toBe(true);
  });

  it("calls the documented endpoints and maps the responses", async () => {
    const seen = capture();
    const client = clientWith(seen, (url) => {
      if (url.includes("/git/trees/")) {
        return json({ sha: "treeabc", truncated: false, tree: [{ path: "src/lib.rs", mode: "100644", type: "blob", sha: "blobabc", size: 12 }] });
      }
      if (url.includes("/git/blobs/")) {
        return json({ sha: "blobabc", url: "https://api.github.com/blob", content: "Zm9vCg==", encoding: "base64" });
      }
      return json({ default_branch: "release" });
    });

    await expect(client.getRepository("acme", "skill-proof")).resolves.toEqual({ defaultBranch: "release" });
    expect(seen.urls[0]).toBe("https://github.example.invalid/api/v3/repos/acme/skill-proof");
    // GitHub's own scheme for a classic/fine-grained PAT, chosen by octokit, not us.
    expect(seen.authorizations[0]).toBe("token ghp_test");

    const tree = await client.getTree("acme", "skill-proof", "release");
    // `recursive=1` is the whole point: without it the walk sees the top-level
    // tree only and would grade a repository as if it had no subdirectories.
    expect(seen.urls[1]).toBe("https://github.example.invalid/api/v3/repos/acme/skill-proof/git/trees/release?recursive=1");
    expect(tree).toEqual({
      treeOid: "treeabc",
      truncated: false,
      entries: [{ path: "src/lib.rs", objectId: "blobabc", mode: "100644", type: "blob", size: 12 }],
    });

    await expect(client.getBlob("acme", "skill-proof", "blobabc")).resolves.toBe("Zm9vCg==");
    expect(seen.urls[2]).toContain("/repos/acme/skill-proof/git/blobs/blobabc");
  });

  it("raises the SDK's own typed error, which the walk turns into a reason", async () => {
    const seen = capture();
    const client = clientWith(seen, () => new Response('{"message":"Not Found"}', { status: 404, headers: { "content-type": "application/json" } }));
    await expect(client.getRepository("acme", "gone")).rejects.toMatchObject({ status: 404 });
    const result = await fetchRepositoryEvidence(REPO_URL, { client });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("REPO_NOT_FOUND");
    }
  });

  it("drives a whole walk against the real SDK with a stub transport", async () => {
    const seen = capture();
    const client = clientWith(seen, (url) => {
      if (url.includes("/git/trees/")) {
        return json({ sha: "t1", truncated: false, tree: [{ path: "src/main.rs", mode: "100644", type: "blob", sha: "b1", size: 5 }] });
      }
      if (url.includes("/git/blobs/")) {
        return json({ sha: "b1", content: btoa("code\n") });
      }
      return json({ default_branch: "main" });
    });
    const result = await fetchRepositoryEvidence(REPO_URL, { client });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) {
      expect(result.data.files).toEqual([{ path: "src/main.rs", content: "code\n", byteLength: 5, sha: "b1" }]);
      expect(result.data.truncated).toEqual({ files: false, bytes: false, scan: false });
      expect(result.data.digest).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(seen.urls).toHaveLength(3);
  });
});
