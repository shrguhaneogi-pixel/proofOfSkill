import Link from "next/link";

import { ChallengeCard } from "@/components/challenge/challenge-card";
import { CHALLENGES } from "@/lib/challenges/data";

export const metadata = {
  title: "Challenges",
  description:
    "Curated technical challenges with published, weighted rubrics. Passing one issues a credential on Solana.",
};

export default function ChallengesPage() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-12">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Explore challenges</h1>
          <p className="mt-2 max-w-prose text-muted-foreground">
            Every challenge ships with its rubric and weights, so you know exactly what is being
            assessed before you submit. Evaluation is offchain and probabilistic; only a passing result
            can be recorded onchain.
          </p>
        </div>
        <p className="font-mono text-xs text-muted-foreground">
          {CHALLENGES.length} challenges · ids 1–{CHALLENGES.length}
        </p>
      </div>

      <ul className="mt-8 grid gap-5 md:grid-cols-2">
        {CHALLENGES.map((challenge) => (
          <li key={challenge.id}>
            <Link
              href={`/challenges/${challenge.slug}`}
              className="block h-full rounded-xl focus-visible:outline-2 focus-visible:outline-ring"
            >
              <ChallengeCard challenge={challenge} />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
