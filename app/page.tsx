import Link from "next/link";

import { HeroVisual } from "@/components/hero/hero-visual";
import { Reveal } from "@/components/common/reveal";
import { StatusChip } from "@/components/common/status-chip";
import { Button } from "@/components/ui/button";
import { CHALLENGES } from "@/lib/challenges/data";

const FLOW = [
  { step: "01", label: "Challenge", detail: "Pick a curated technical task with a published rubric." },
  { step: "02", label: "Submission", detail: "Explain your approach, paste real code, link a repo." },
  { step: "03", label: "AI Evaluation", detail: "A model scores each rubric criterion. Server recomputes the total." },
  { step: "04", label: "Onchain Verification", detail: "A pass is issued as a credential PDA, co-signed by an issuer." },
  { step: "05", label: "Reputation", detail: "Anyone can open the public verify page and read it from Solana." },
] as const;

/** Mirrors `CREDENTIAL_SEED` plus its seed arguments in the onchain program. */
const CREDENTIAL_SEED_TEXT = '["credential", wallet, challenge]';

export default function HomePage() {
  return (
    <div className="mx-auto max-w-6xl px-6">
      <section className="grid gap-10 py-16 md:grid-cols-[1.15fr_0.85fr] md:py-24">
        <div className="flex flex-col items-start gap-6">
          <StatusChip kind="onchain-verified" label="Devnet · Solana" />
          <h1 className="text-balance text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
            Demonstrated skill, recorded onchain.
          </h1>
          <p className="max-w-prose text-lg text-muted-foreground">
            ProofOfSkill turns a technical challenge you actually completed into a portable credential.
            An AI grades your evidence against a fixed rubric; Solana records that wallet X passed
            challenge Y with score Z. The chain is the source of truth for the credential — not for the
            quality of your code.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button size="lg" render={<Link href="/challenges" />}>Explore challenges</Button>
            <Button size="lg" variant="outline" render={<Link href="/verify" />}>
              Verify a credential
            </Button>
          </div>
          <p className="font-mono text-xs text-muted-foreground">
            {CHALLENGES.length} curated challenges · weighted rubrics · pass threshold 70
          </p>
        </div>

        <div className="rounded-xl border border-border bg-surface p-5">
          <HeroVisual />
          <p className="mt-4 text-xs text-muted-foreground">
            The tile is the credential: wallet, challenge, score and a hash of the evidence. Static
            fallback when WebGL is unavailable or reduced motion is on.
          </p>
        </div>
      </section>

      <section aria-labelledby="pipeline-heading" className="border-t border-border py-14">
        <h2 id="pipeline-heading" className="text-2xl font-semibold tracking-tight">
          The path from challenge to reputation
        </h2>
        <ol className="mt-6 grid gap-4 md:grid-cols-5">
          {FLOW.map((item, index) => (
            <li key={item.step} className="h-full">
              <Reveal delay={index * 60} className="h-full">
                <div className="h-full rounded-xl border border-border p-4">
                  <span className="font-mono text-xs tabular-nums text-brand">{item.step}</span>
                  <p className="mt-2 text-sm font-medium">{item.label}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{item.detail}</p>
                </div>
              </Reveal>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="two-layers" className="border-t border-border py-14">
        <h2 id="two-layers" className="text-2xl font-semibold tracking-tight">
          Two separate claims, never blended
        </h2>
        <div className="mt-6 grid gap-5 md:grid-cols-2">
          <article className="rounded-xl border border-border p-5">
            <StatusChip kind="ai-evaluated" />
            <h3 className="mt-3 text-lg font-medium">AI Evaluation</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              A large model reads your explanation and code and awards points per rubric criterion. The
              server clamps every score to the criterion weight and recomputes the total, so the model
              never decides pass or fail. It is an assessment, and it can be wrong.
            </p>
          </article>
          <article className="rounded-xl border border-border p-5">
            <StatusChip kind="onchain-verified" />
            <h3 className="mt-3 text-lg font-medium">Onchain Verification</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              A credential account derived from your wallet and the challenge id stores the score, the
              issue time and a SHA-256 hash of your submission. Solana proves the credential state and
              ownership. It does not prove your code is correct.
            </p>
          </article>
        </div>
      </section>

      <section aria-labelledby="why-chain" className="border-t border-border py-14">
        <h2 id="why-chain" className="text-2xl font-semibold tracking-tight">
          Why the chain has to be here
        </h2>
        <p className="mt-4 max-w-prose text-muted-foreground">
          A grade in a database can be edited by whoever owns the database. On ProofOfSkill the program
          only accepts an issuance co-signed by the registered issuer key, only for a challenge id it
          knows, only with a score at or above the passing threshold, and exactly once per wallet per
          challenge. Removing the chain removes the part a third party can check without trusting us.
        </p>
        <ul className="mt-6 grid gap-3 text-sm md:grid-cols-3">
          <li className="rounded-lg border border-border p-4">
            <p className="font-medium">Deterministic PDAs</p>
            <p className="mt-1 text-muted-foreground">
              <code className="font-mono text-xs">{CREDENTIAL_SEED_TEXT}</code> — duplicates cannot be
              created.
            </p>
          </li>
          <li className="rounded-lg border border-border p-4">
            <p className="font-medium">Issuer authorization</p>
            <p className="mt-1 text-muted-foreground">
              The AI never signs a transaction. A server-held issuer key does.
            </p>
          </li>
          <li className="rounded-lg border border-border p-4">
            <p className="font-medium">Evidence integrity</p>
            <p className="mt-1 text-muted-foreground">
              Large submissions stay offchain; only their hash is committed.
            </p>
          </li>
        </ul>
      </section>
    </div>
  );
}
