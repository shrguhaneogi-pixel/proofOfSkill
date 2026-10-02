import { describe, expect, it } from "vitest";

import { canonicalizeSubmission, type SubmissionFields } from "./canonicalize";
import { sha256Hex } from "./evidence-hash";

const base: SubmissionFields = {
  challengeId: 1,
  explanation: "A PDA is derived from seeds.\r\nNo wallet can sign for it.  ",
  code: '  fn main() {\r\n    msg!("hi");\r\n  }\r\n  ',
  repoUrl: "https://github.com/acme/skill-proof",
};

describe("canonicalizeSubmission", () => {
  it("sorts keys alphabetically and folds CRLF", () => {
    expect(canonicalizeSubmission(base)).toBe(
      '{"challengeId":1,"code":"fn main() {\\n    msg!(\\"hi\\");\\n  }","explanation":"A PDA is derived from seeds.\\nNo wallet can sign for it.","repoUrl":"https://github.com/acme/skill-proof"}',
    );
  });

  it("is stable regardless of input key order", () => {
    const reordered = {
      code: base.code,
      repoUrl: base.repoUrl,
      explanation: base.explanation,
      challengeId: base.challengeId,
    } as SubmissionFields;
    expect(canonicalizeSubmission(reordered)).toBe(canonicalizeSubmission(base));
  });

  it("ignores line endings and surrounding whitespace", () => {
    const lfOnly: SubmissionFields = {
      ...base,
      explanation: "A PDA is derived from seeds.\nNo wallet can sign for it.",
      code: 'fn main() {\n    msg!("hi");\n  }',
    };
    expect(canonicalizeSubmission(lfOnly)).toBe(canonicalizeSubmission(base));
  });

  it("omits an absent repo url entirely", () => {
    const withoutRepo: SubmissionFields = { ...base, repoUrl: undefined };
    expect(canonicalizeSubmission(withoutRepo)).not.toContain("repoUrl");
  });

  it("changes when any content changes", () => {
    const edited: SubmissionFields = { ...base, explanation: `${base.explanation} extra` };
    expect(canonicalizeSubmission(edited)).not.toBe(canonicalizeSubmission(base));
  });
});

describe("sha256Hex", () => {
  // Digests produced independently with node:crypto over the same canonical
  // strings, so they pin both the canonical form and the hash.
  it("matches the fixed vector with a repo url", async () => {
    await expect(sha256Hex(canonicalizeSubmission(base))).resolves.toBe(
      "63c446cf82ccd52235e415b7f3de9969f75459676cd0fbb1e44041e339152b77",
    );
  });

  it("matches the fixed vector without a repo url", async () => {
    const withoutRepo: SubmissionFields = { ...base, challengeId: 2, repoUrl: undefined };
    await expect(sha256Hex(canonicalizeSubmission(withoutRepo))).resolves.toBe(
      "f704cac90d02c7d0ce98e984efa5c2a42999e2a6a31c74ec3c308e090ebc9763",
    );
  });

  it("is deterministic across calls", async () => {
    const first = await sha256Hex(canonicalizeSubmission(base));
    const second = await sha256Hex(canonicalizeSubmission({ ...base }));
    expect(first).toBe(second);
  });
});
