import { Badge } from "@/components/ui/badge";

import type { Challenge } from "@/lib/challenges/types";

const DIFFICULTY_STYLE: Record<Challenge["difficulty"], string> = {
  beginner: "border-success/40 text-success",
  intermediate: "border-warning/40 text-warning",
  advanced: "border-destructive/40 text-destructive",
};

export function ChallengeCard({ challenge }: { challenge: Challenge }) {
  return (
    <article className="flex h-full flex-col gap-3 rounded-xl border border-border bg-card p-5 text-card-foreground transition-colors hover:border-brand/50">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary" className="font-mono">
          #{challenge.id}
        </Badge>
        <span
          className={`rounded-full border px-2 py-0.5 text-[0.6875rem] uppercase tracking-wide ${DIFFICULTY_STYLE[challenge.difficulty]}`}
        >
          {challenge.difficulty}
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          ~{challenge.estimatedMinutes} min
        </span>
      </div>

      <h2 className="text-lg font-semibold leading-snug">{challenge.title}</h2>
      <p className="text-sm text-muted-foreground">{challenge.description}</p>

      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <span className="text-xs text-muted-foreground">{challenge.category}</span>
        <span className="font-mono text-[0.6875rem] text-muted-foreground">
          {challenge.rubric.length} criteria · 100 pts
        </span>
      </div>
    </article>
  );
}
