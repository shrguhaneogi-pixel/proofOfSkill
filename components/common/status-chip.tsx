import { cn } from "@/lib/utils";

/**
 * The two trust layers must never blur together, so their chips are separate
 * components with separate vocabulary: `AI EVALUATED` is an assessment,
 * `ONCHAIN VERIFIED` is a recorded state. Copy rules live in docs/styleguide.md.
 */
export type StatusKind = "ai-evaluated" | "pass" | "fail" | "onchain-verified" | "pending";

const STYLES: Record<StatusKind, string> = {
  "ai-evaluated": "border-brand/40 bg-brand/10 text-brand",
  pass: "border-success/40 bg-success/10 text-success",
  fail: "border-destructive/40 bg-destructive/10 text-destructive",
  "onchain-verified": "border-foreground/25 bg-surface text-foreground",
  pending: "border-warning/40 bg-warning/10 text-warning",
};

const LABELS: Record<StatusKind, string> = {
  "ai-evaluated": "AI Evaluated",
  pass: "Pass",
  fail: "Fail",
  "onchain-verified": "Onchain Verified",
  pending: "Pending",
};

export function StatusChip({
  kind,
  label,
  className,
}: {
  kind: StatusKind;
  label?: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1",
        "font-mono text-[0.6875rem] uppercase tracking-wide",
        STYLES[kind],
        className,
      )}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {label ?? LABELS[kind]}
    </span>
  );
}
