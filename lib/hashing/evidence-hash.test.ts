import { describe, expect, it } from "vitest";

import { canonicalizeSubmission, type SubmissionFields } from "./canonicalize";
import {
  EVIDENCE_REPO_TAG,
  evidencePreimage,
  sha256EvidenceHash,
  sha256Hex,
} from "./evidence-hash";

/**
 * The preimage rules for `evidence_hash`, and the compatibility guarantee:
 * a submission with no fetched repository content must hash exactly as it did
 * before repository inspection existed, or every credential already onchain would
 * stop re-deriving. Vectors are computed independently with `node:crypto` over the
 * same strings, as in `canonicalize.test.ts`.
 */

const base: SubmissionFields = {
  challengeId: 1,
  explanation: "A PDA is derived from seeds.\r\nNo wallet can sign for it.  ",
  code: '  fn main() {\r\n    msg!("hi");\r\n  }\r\n  ',
  repoUrl: "https://github.com/acme/skill-proof",
};

const canonical = canonicalizeSubmission(base);
const TREE_DIGEST = "a".repeat(64);

describe("evidencePreimage", () => {
  it("is the canonical submission verbatim when nothing was fetched", () => {
    expect(evidencePreimage(canonical)).toBe(canonical);
    expect(evidencePreimage(canonical, undefined)).toBe(canonical);
    // An empty digest means "no evidence", not "evidence of nothing": it must not
    // create a second hashable shape for the same submission.
    expect(evidencePreimage(canonical, "")).toBe(canonical);
  });

  it("names the tag and the digest when a tree was fetched", () => {
    const preimage = evidencePreimage(canonical, TREE_DIGEST);
    const parsed = JSON.parse(preimage) as Record<string, string>;
    expect(parsed).toEqual({ evidence: EVIDENCE_REPO_TAG, repoDigest: TREE_DIGEST, submission: canonical });
    // The submission is embedded as a string, so its own quotes cannot shift.
    expect(preimage).toContain('\\"challengeId\\"');
  });

  it("never contains a repo digest in the legacy shape", () => {
    expect(evidencePreimage(canonical)).not.toContain(TREE_DIGEST);
    expect(evidencePreimage(canonical, TREE_DIGEST)).not.toBe(evidencePreimage(canonical));
  });
});

describe("sha256EvidenceHash", () => {
  it("matches the pinned legacy vector with a repo url", async () => {
    await expect(sha256EvidenceHash(canonical)).resolves.toBe(
      "63c446cf82ccd52235e415b7f3de9969f75459676cd0fbb1e44041e339152b77",
    );
  });

  it("matches the pinned legacy vector without a repo url", async () => {
    const withoutRepo = canonicalizeSubmission({ ...base, challengeId: 2, repoUrl: undefined });
    await expect(sha256EvidenceHash(withoutRepo)).resolves.toBe(
      "f704cac90d02c7d0ce98e984efa5c2a42999e2a6a31c74ec3c308e090ebc9763",
    );
  });

  it("agrees with sha256Hex over the canonical string when there is no evidence", async () => {
    await expect(sha256EvidenceHash(canonical)).resolves.toBe(await sha256Hex(canonical));
  });

  it("matches the pinned vector that includes a fetched tree digest", async () => {
    await expect(sha256EvidenceHash(canonical, TREE_DIGEST)).resolves.toBe(
      "568f39894354d9826802d42236f6bbeea91fa91eebf4999937cb1e58947648f3",
    );
  });

  it("is deterministic, and every field of the manifest changes it", async () => {
    const first = await sha256EvidenceHash(canonical, TREE_DIGEST);
    await expect(sha256EvidenceHash(canonical, TREE_DIGEST)).resolves.toBe(first);
    await expect(sha256EvidenceHash(canonical, "b".repeat(64))).resolves.not.toBe(first);
    await expect(sha256EvidenceHash(`${canonical} `, TREE_DIGEST)).resolves.not.toBe(first);
  });
});
