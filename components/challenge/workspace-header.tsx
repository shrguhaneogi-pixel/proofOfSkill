"use client";

import { StatusChip } from "@/components/common/status-chip";

import type { StoredEvaluation } from "@/components/challenge/stored-evaluation";

/**
 * One status line for the workspace. A pass that carries no attestation is
 * labelled honestly as not issuable rather than showing a green PASS the user
 * cannot act on.
 */
export function ChallengeWorkspaceHeader({
  result,
  canIssue,
  issued,
}: {
  result: StoredEvaluation | null;
  canIssue: boolean;
  issued: boolean;
}) {
  if (issued) {
    return <StatusChip kind="onchain-verified" />;
  }
  if (result?.passed) {
    return (
      <StatusChip kind={canIssue ? "pass" : "pending"} label={canIssue ? "Pass" : "Pass · not issuable"} />
    );
  }
  if (result) {
    return <StatusChip kind="fail" />;
  }
  return <StatusChip kind="ai-evaluated" label="Awaiting submission" />;
}
