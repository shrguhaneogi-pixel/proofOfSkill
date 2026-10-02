"use client";

import { StatusChip } from "@/components/common/status-chip";
import { MonoValue } from "@/components/common/mono-value";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

import type { EvaluationResult } from "@/lib/evaluation/types";

const STATUS_LABEL = { met: "Met", partial: "Partial", not_met: "Not met" } as const;

const STATUS_STYLE = {
  met: "text-success",
  partial: "text-warning",
  not_met: "text-destructive",
} as const;

type Props = {
  result: EvaluationResult;
  onIssue: () => void;
  issuing: boolean;
  /** Present only when a real provider produced this and it can be issued. */
  canIssue: boolean;
};

export function EvaluationPanel({ result, onIssue, issuing, canIssue }: Props) {
  const isFallback = result.devFallback === true || result.provider === "dev-fallback";

  return (
    <section aria-labelledby="evaluation-heading" className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="evaluation-heading" className="text-lg font-semibold">
          AI Evaluation
        </h2>
        <StatusChip kind="ai-evaluated" />
        <StatusChip kind={result.passed ? "pass" : "fail"} />
      </div>

      {isFallback && (
        <Alert className="border-warning/60">
          <AlertTitle>Development fallback — not an AI evaluation</AlertTitle>
          <AlertDescription>
            No model was called, so nothing here was assessed against the rubric by an AI. This result
            cannot be issued onchain. Set <code className="font-mono text-xs">AI_API_KEY</code> to run a
            real evaluation.
          </AlertDescription>
        </Alert>
      )}

      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Score</p>
            <p className="font-mono text-4xl font-semibold tabular-nums leading-none">
              {result.score}
              <span className="text-lg text-muted-foreground">/100</span>
            </p>
          </div>
          <p className="font-mono text-xs text-muted-foreground">
            pass threshold {result.passThreshold}
          </p>
        </div>
        <Progress value={result.score} className="mt-4 h-2" />
      </div>

      <div className="rounded-xl border border-border">
        <h3 className="border-b border-border px-5 py-3 text-sm font-semibold uppercase tracking-wide">
          Rubric criteria
        </h3>
        <ul className="divide-y divide-border">
          {result.evaluatedCriteria.map((criterion) => (
            <li key={criterion.id} className="grid gap-2 px-5 py-4 sm:grid-cols-[1fr_auto]">
              <div>
                <p className="text-sm font-medium">{criterion.label}</p>
                <p className="mt-1 text-sm text-muted-foreground">{criterion.comment}</p>
              </div>
              <div className="text-right">
                <p className="font-mono text-sm tabular-nums">
                  {criterion.pointsAwarded}/{criterion.weight}
                </p>
                <p
                  className={`font-mono text-[0.6875rem] uppercase tracking-wide ${STATUS_STYLE[criterion.status]}`}
                >
                  {STATUS_LABEL[criterion.status]}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        <ListBlock title="Strengths" items={result.strengths} tone="success" />
        <ListBlock title="To improve" items={result.weaknesses} tone="warning" />
      </div>

      <div className="rounded-xl border border-border p-5">
        <h3 className="text-sm font-semibold uppercase tracking-wide">Feedback</h3>
        <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{result.feedback}</p>
      </div>

      <div className="rounded-xl border border-border bg-surface p-5 text-sm">
        <p className="font-mono text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
          Evidence
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-x-6 gap-y-2">
          <span>
            <span className="text-muted-foreground">hash </span>
            <MonoValue value={result.evidenceHash} label="Evidence hash" />
          </span>
          <span className="text-muted-foreground">
            provider <span className="font-mono">{result.provider}</span>
          </span>
          <span className="text-muted-foreground">
            evaluated <span className="font-mono">{result.evaluatedAt}</span>
          </span>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          This hash commits the canonicalized submission, so the evidence referenced here cannot be
          quietly changed. It proves integrity of the evidence representation, not the quality of the
          work.
        </p>
      </div>

      {result.passed ? (
        canIssue ? (
          <button
            type="button"
            onClick={onIssue}
            disabled={issuing}
            className="w-full rounded-lg bg-brand px-5 py-3 text-base font-medium text-brand-foreground transition-opacity hover:opacity-95 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-ring"
          >
            {issuing ? "Preparing transaction…" : "Issue onchain credential"}
          </button>
        ) : (
          <p className="rounded-lg border border-dashed border-border px-5 py-4 text-sm text-muted-foreground">
            This pass cannot be issued onchain — no issuer attestation was minted for it.
          </p>
        )
      ) : (
        <p className="rounded-lg border border-dashed border-border px-5 py-4 text-sm text-muted-foreground">
          A failing result is never written onchain. Revise your submission against the criteria above
          and try again.
        </p>
      )}
    </section>
  );
}

function ListBlock({
  title,
  items,
  tone,
}: {
  title: string;
  items: string[];
  tone: "success" | "warning";
}) {
  return (
    <div className="rounded-xl border border-border p-5">
      <h3 className="text-sm font-semibold uppercase tracking-wide">{title}</h3>
      {items.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">None reported.</p>
      ) : (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm marker:text-current">
          {items.map((item) => (
            <li key={item} className={tone === "success" ? "text-foreground" : "text-muted-foreground"}>
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
