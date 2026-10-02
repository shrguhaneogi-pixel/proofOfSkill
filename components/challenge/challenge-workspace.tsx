"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { ChallengeWorkspaceHeader } from "@/components/challenge/workspace-header";
import {
  clearStoredEvaluation,
  useStoredEvaluation,
  writeStoredEvaluation,
  type StoredEvaluation,
} from "@/components/challenge/stored-evaluation";
import { EvaluationPanel } from "@/components/evaluation/evaluation-panel";
import { SubmissionForm } from "@/components/evaluation/submission-form";
import { TransactionStatus } from "@/components/transaction/tx-status";
import { useIssueCredential } from "@/components/transaction/use-issue-credential";
import { isBusy } from "@/components/transaction/tx-machine";

import type { Challenge } from "@/lib/challenges/types";

type ApiError = { error?: { code?: string; message?: string } };

export function ChallengeWorkspace({ challenge }: { challenge: Challenge }) {
  const stored = useStoredEvaluation(challenge.id);
  const [fresh, setFresh] = useState<StoredEvaluation | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [apiError, setApiError] = useState<{ code: string; message: string } | null>(null);
  const [issued, setIssued] = useState<{ signature: string; credentialPda: string } | null>(null);

  const result = fresh ?? stored;
  const attestation = result?.attestation;
  const canIssue = Boolean(result?.passed && attestation);

  const { state, issue, reset } = useIssueCredential({
    attestation: attestation ?? "",
    onIssued: useCallback((value) => setIssued(value), []),
  });

  const submitting = isBusy(state);

  const handleSubmit = useCallback(
    async (submission: { challengeId: number; explanation: string; code: string; repoUrl?: string }) => {
      setEvaluating(true);
      setApiError(null);
      try {
        const response = await fetch("/api/evaluate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(submission),
        });
        const body = (await response.json()) as StoredEvaluation & ApiError;

        if (!response.ok) {
          setApiError({
            code: body.error?.code ?? "EVALUATION_FAILED",
            message: body.error?.message ?? "The evaluator could not score this submission.",
          });
          return;
        }

        writeStoredEvaluation(body);
        setFresh(body);
        setIssued(null);
      } catch {
        setApiError({
          code: "NETWORK_ERROR",
          message: "Could not reach the evaluator. Check the connection and try again.",
        });
      } finally {
        setEvaluating(false);
      }
    },
    [],
  );

  const startOver = useCallback(() => {
    clearStoredEvaluation(challenge.id);
    setFresh(null);
    setIssued(null);
    setApiError(null);
    reset();
  }, [challenge.id, reset]);

  const heading = useMemo(
    () => (
      <ChallengeWorkspaceHeader
        result={result}
        canIssue={canIssue}
        issued={issued !== null}
      />
    ),
    [canIssue, issued, result],
  );

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-lg font-semibold">Your workspace</h2>
        {heading}
      </div>

      {evaluating && <EvaluationProgress />}

      {apiError && (
        <div role="alert" className="rounded-xl border border-destructive/50 bg-destructive/5 p-5">
          <p className="font-mono text-xs uppercase tracking-wide text-destructive">{apiError.code}</p>
          <p className="mt-2 text-sm">{apiError.message}</p>
        </div>
      )}

      {!result && !evaluating && (
        <SubmissionForm
          challengeId={challenge.id}
          pending={false}
          onSubmit={async (submission) => {
            await handleSubmit(submission);
          }}
        />
      )}

      {result && !evaluating && (
        <>
          <EvaluationPanel
            result={result}
            canIssue={canIssue}
            issuing={submitting}
            onIssue={() => {
              void issue();
            }}
          />
          {(submitting || state.status === "failed" || state.status === "success") && (
            <TransactionStatus
              state={state}
              credentialPda={issued?.credentialPda}
              onRetry={() => {
                reset();
                void issue();
              }}
            />
          )}
          {!submitting && state.status !== "success" && (
            <button
              type="button"
              onClick={startOver}
              className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
            >
              Discard this evaluation and submit a new answer
            </button>
          )}
        </>
      )}
    </div>
  );
}

const EVALUATION_STEPS = [
  "Reading your submission",
  "Scoring each rubric criterion",
  "Recomputing the total from weights",
] as const;

function EvaluationProgress() {
  const [step, setStep] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setStep((current) => Math.min(current + 1, EVALUATION_STEPS.length - 1));
    }, 2200);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div
      role="status"
      aria-live="polite"
      className="space-y-3 rounded-xl border border-border bg-surface p-5"
    >
      <p className="text-sm font-medium">Evaluating against the published rubric</p>
      <ul className="space-y-2 text-sm">
        {EVALUATION_STEPS.map((label, index) => (
          <li
            key={label}
            className={index <= step ? "text-foreground" : "text-muted-foreground"}
          >
            <span className="font-mono text-xs">{index <= step ? "•" : "○"}</span> {label}
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        The model scores criteria only. Pass or fail is computed by the server from the weights.
      </p>
    </div>
  );
}
