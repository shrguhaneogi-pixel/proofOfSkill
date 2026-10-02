import Link from "next/link";

import { MonoValue } from "@/components/common/mono-value";
import { StatusChip } from "@/components/common/status-chip";
import { Button } from "@/components/ui/button";
import { findChallenge } from "@/lib/challenges/data";
import { bytesToHex } from "@/lib/hashing/evidence-hash";
import { parsePublicKey } from "@/lib/solana/codecs";
import { getConnection } from "@/lib/solana/connection";
import { addressExplorerHref } from "@/lib/solana/explorer";
import { fetchCredentialAccount } from "@/lib/solana/queries";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ credentialId: string }> };

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-3xl px-6 py-14">{children}</div>;
}

function StateCard({
  code,
  title,
  detail,
  tone,
}: {
  code: string;
  title: string;
  detail: string;
  tone: "fail" | "pending";
}) {
  return (
    <Shell>
      <div className="rounded-xl border border-border p-6">
        <StatusChip kind={tone} label={code} />
        <h1 className="mt-4 text-2xl font-semibold">{title}</h1>
        <p className="mt-2 text-muted-foreground">{detail}</p>
        <div className="mt-6 flex gap-3">
          <Button render={<Link href="/verify" />} variant="outline" size="sm">
            Check another credential
          </Button>
          <Button render={<Link href="/challenges" />} size="sm">
            Browse challenges
          </Button>
        </div>
      </div>
    </Shell>
  );
}

function formatIssuedAt(unixSeconds: bigint | number): string {
  const seconds = typeof unixSeconds === "bigint" ? Number(unixSeconds) : unixSeconds;
  // A credential issued before 2000-01-01 is corrupt data, not a date to print.
  if (!Number.isFinite(seconds) || seconds < 946_684_800) {
    return "unknown";
  }
  return new Date(seconds * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC");
}

export default async function VerifyCredentialPage({ params }: PageProps) {
  const { credentialId } = await params;

  const address = parsePublicKey(credentialId);
  if (!address.ok) {
    return (
      <StateCard
        code="INVALID ADDRESS"
        title="That is not a credential address"
        detail="A credential id is the base58 address of a credential account on Solana. Check the link you followed."
        tone="fail"
      />
    );
  }

  const result = await fetchCredentialAccount(getConnection(), address.data);
  if (!result.ok) {
    return (
      <StateCard
        code="RPC UNAVAILABLE"
        title="Could not read that account"
        detail="The RPC did not answer, or the bytes at that address do not match a credential. Try again in a moment."
        tone="pending"
      />
    );
  }
  if (result.data === null) {
    return (
      <StateCard
        code="NOT FOUND"
        title="No credential at this address"
        detail="Nothing exists on this network at that address. Credentials live on Devnet in this build, so a mainnet or localnet address will not resolve here."
        tone="fail"
      />
    );
  }

  const credential = result.data;
  const challenge = findChallenge(credential.challengeId);
  const explorer = addressExplorerHref(address.data.toBase58());

  return (
    <Shell>
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip kind="onchain-verified" />
        <StatusChip kind="pass" label={`Score ${credential.score}`} />
      </div>

      <h1 className="mt-4 text-3xl font-semibold tracking-tight">
        {challenge?.title ?? `Challenge #${credential.challengeId}`}
      </h1>
      <p className="mt-2 text-muted-foreground">
        This record exists on Solana. It states that the wallet below completed the challenge with the
        score below, and commits to the evidence that was submitted.
      </p>

      <dl className="mt-8 divide-y divide-border rounded-xl border border-border">
        <Row label="Credential account">
          <MonoValue value={address.data.toBase58()} label="Credential address" full />
        </Row>
        <Row label="Wallet">
          <MonoValue value={credential.user.toBase58()} label="Wallet address" />
        </Row>
        <Row label="Challenge">
          <span className="font-mono text-sm">
            #{credential.challengeId}
            {challenge ? ` · ${challenge.slug}` : " · not in this catalogue"}
          </span>
        </Row>
        <Row label="Score">
          <span className="font-mono text-sm tabular-nums">{credential.score} / 100</span>
        </Row>
        <Row label="Issued">
          <span className="font-mono text-sm">{formatIssuedAt(credential.issuedAt)}</span>
        </Row>
        <Row label="Issuer">
          <MonoValue value={credential.issuer.toBase58()} label="Issuer address" />
        </Row>
        <Row label="Evidence hash (SHA-256)">
          <MonoValue value={bytesToHex(credential.evidenceHash)} label="Evidence hash" full />
        </Row>
      </dl>

      <div className="mt-6 space-y-3">
        {explorer && (
          <a
            href={explorer}
            target="_blank"
            rel="noreferrer"
            className="inline-block text-sm text-brand underline underline-offset-4"
          >
            View this account on Solana Explorer
          </a>
        )}
        <p className="rounded-lg border border-dashed border-border p-4 text-xs text-muted-foreground">
          What this proves: a registered issuer co-signed this record and the network stored it. What it
          does not prove: that the work is correct. The score came from a rubric-based AI evaluation, and
          the hash binds this credential to the evidence representation rather than to its quality. The
          full submission and the evaluation detail are not stored onchain.
        </p>
      </div>
    </Shell>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
