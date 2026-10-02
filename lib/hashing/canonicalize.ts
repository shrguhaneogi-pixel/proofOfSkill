/**
 * Canonical submission serialization, shared by the browser (before signing
 * anything) and the server (which produces the authoritative hash). Any drift
 * here changes the onchain `evidence_hash`, so it is pinned by fixed vectors in
 * `canonicalize.test.ts`.
 */

export type SubmissionFields = {
  challengeId: number;
  explanation: string;
  code: string;
  repoUrl?: string;
};

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

/**
 * Keys sorted alphabetically, CRLF folded to LF, text fields trimmed, absent
 * `repoUrl` omitted entirely, no insignificant whitespace.
 */
export function canonicalizeSubmission(submission: SubmissionFields): string {
  const canonical: Record<string, string | number> = {
    challengeId: submission.challengeId,
    code: normalizeText(submission.code),
    explanation: normalizeText(submission.explanation),
  };

  if (submission.repoUrl !== undefined && submission.repoUrl !== "") {
    canonical.repoUrl = submission.repoUrl;
  }

  const sortedKeys = Object.keys(canonical).sort();
  const ordered: Record<string, string | number> = {};
  for (const key of sortedKeys) {
    ordered[key] = canonical[key];
  }

  return JSON.stringify(ordered);
}
