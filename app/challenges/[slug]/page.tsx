import Link from "next/link";
import { notFound } from "next/navigation";

import { ChallengeWorkspace } from "@/components/challenge/challenge-workspace";
import { Badge } from "@/components/ui/badge";
import { CHALLENGES, findChallengeBySlug } from "@/lib/challenges/data";

type PageProps = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return CHALLENGES.map((challenge) => ({ slug: challenge.slug }));
}

export async function generateMetadata({ params }: PageProps) {
  const { slug } = await params;
  const challenge = findChallengeBySlug(slug);
  if (!challenge) {
    return { title: "Challenge not found" };
  }
  return { title: challenge.title, description: challenge.description };
}

export default async function ChallengePage({ params }: PageProps) {
  const { slug } = await params;
  const challenge = findChallengeBySlug(slug);
  if (!challenge) {
    notFound();
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <Link
        href="/challenges"
        className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        ← All challenges
      </Link>

      <header className="mt-4 flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">{challenge.title}</h1>
        <Badge variant="secondary" className="font-mono">
          #{challenge.id}
        </Badge>
        <span className="text-sm text-muted-foreground">
          {challenge.category} · {challenge.difficulty} · ~{challenge.estimatedMinutes} min
        </span>
      </header>

      <p className="mt-3 max-w-prose text-muted-foreground">{challenge.description}</p>

      <div className="mt-8 grid gap-8 lg:grid-cols-[1.1fr_0.9fr]">
        <ChallengeWorkspace challenge={challenge} />

        <aside className="space-y-6">
          <section className="rounded-xl border border-border bg-surface p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wide">What you must produce</h2>
            <pre className="mt-3 whitespace-pre-wrap font-sans text-sm leading-relaxed text-muted-foreground">
              {challenge.prompt}
            </pre>
          </section>

          <section className="rounded-xl border border-border p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wide">Rubric</h2>
            <ul className="mt-3 space-y-2 text-sm">
              {challenge.rubric.map((criterion) => (
                <li key={criterion.id} className="flex items-baseline justify-between gap-3">
                  <span>{criterion.label}</span>
                  <span className="font-mono tabular-nums text-muted-foreground">
                    {criterion.weight}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-3 border-t border-border pt-3 font-mono text-xs text-muted-foreground">
              total 100 · pass threshold 70
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}
