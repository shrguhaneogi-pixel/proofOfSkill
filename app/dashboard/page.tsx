"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";

import { MonoValue } from "@/components/common/mono-value";
import { StatusChip } from "@/components/common/status-chip";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { findChallenge } from "@/lib/challenges/data";
import type { Category } from "@/lib/challenges/types";
import { addressExplorerHref } from "@/lib/solana/explorer";
import { fetchWalletSnapshot, type WalletSnapshot } from "@/lib/solana/queries";

/**
 * Results are tagged with the wallet they belong to, so "loading" is derived
 * rather than tracked in a second state variable that can disagree with the
 * data on screen. Switching wallets shows the new wallet as loading immediately
 * and can never leave the previous wallet's credentials on screen.
 */
type LoadResult =
  | { wallet: string; snapshot: WalletSnapshot }
  | { wallet: string; error: string };

export default function DashboardPage() {
  const { publicKey, connected } = useWallet();
  const { connection } = useConnection();
  const [result, setResult] = useState<LoadResult | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const walletKey = publicKey?.toBase58() ?? "";

  useEffect(() => {
    if (!connected || !publicKey) {
      return;
    }
    let cancelled = false;

    // Nothing here sets state before the await, so the read stays asynchronous.
    void fetchWalletSnapshot(connection, publicKey).then((outcome) => {
      if (cancelled) {
        return;
      }
      setRefreshing(false);
      setResult(
        outcome.ok
          ? { wallet: publicKey.toBase58(), snapshot: outcome.data }
          : { wallet: publicKey.toBase58(), error: outcome.error },
      );
    });

    return () => {
      cancelled = true;
    };
  }, [connection, connected, publicKey, reloadToken]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    setReloadToken((token) => token + 1);
  }, []);

  if (!connected || !publicKey) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-20 text-center">
        <h1 className="text-2xl font-semibold">Your credentials</h1>
        <p className="mt-3 text-muted-foreground">
          Connect the wallet you completed challenges with. Credentials are derived from the wallet
          address, so this list is whatever the chain holds for that address — nothing is stored about
          you in between.
        </p>
        <Button className="mt-6" render={<Link href="/challenges" />}>
          Start a challenge
        </Button>
      </div>
    );
  }

  const loading = result?.wallet !== walletKey || refreshing;
  const snapshot = result && result.wallet === walletKey && "snapshot" in result ? result.snapshot : null;
  const error = result && result.wallet === walletKey && "error" in result ? result.error : null;

  const credentials = snapshot?.credentials ?? [];
  const average =
    credentials.length === 0
      ? 0
      : Math.round(credentials.reduce((sum, item) => sum + item.account.score, 0) / credentials.length);

  const categories = new Set<Category>(
    credentials
      .map((item) => findChallenge(item.account.challengeId)?.category)
      .filter((category): category is Category => category !== undefined),
  );

  return (
    <div className="mx-auto max-w-4xl px-6 py-12">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Your credentials</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Wallet <MonoValue value={publicKey.toBase58()} label="Wallet address" />
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
          {loading ? "Reading from chain…" : "Reload from chain"}
        </Button>
      </div>

      <section aria-label="Reputation summary" className="mt-8 grid gap-4 sm:grid-cols-3">
        <Stat label="Verified credentials" value={loading ? "…" : String(credentials.length)} />
        <Stat label="Average score" value={loading || credentials.length === 0 ? "—" : String(average)} />
        <Stat label="Skill categories" value={loading ? "…" : String(categories.size)} />
      </section>

      {snapshot?.profile && (
        <p className="mt-4 font-mono text-xs text-muted-foreground">
          profile opened {new Date(Number(snapshot.profile.createdAt) * 1000).toISOString().slice(0, 10)}
          {" · "}onchain reputation {snapshot.profile.reputation}
          {" · "}completed {snapshot.profile.completedCount}
        </p>
      )}

      {error && (
        <div role="alert" className="mt-8 rounded-xl border border-destructive/50 bg-destructive/5 p-5">
          <p className="text-sm font-medium">Could not read this wallet from the network</p>
          <p className="mt-1 text-sm text-muted-foreground">
            The RPC did not answer, or an account did not match the expected layout. Try again in a
            moment.
          </p>
        </div>
      )}

      {loading && !error && (
        <div className="mt-8 space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}

      {!loading && !error && credentials.length === 0 && (
        <div className="mt-8 rounded-xl border border-dashed border-border p-8 text-center">
          <StatusChip kind="pending" label="No credentials yet" />
          <p className="mt-3 text-sm text-muted-foreground">
            Passing a challenge and signing the issue transaction records a credential here.
          </p>
          <Button className="mt-5" render={<Link href="/challenges" />}>
            Browse challenges
          </Button>
        </div>
      )}

      {!loading && credentials.length > 0 && (
        <ul className="mt-8 space-y-3">
          {credentials
            .slice()
            .sort(
              (a, b) =>
                Number(b.account.issuedAt) - Number(a.account.issuedAt) ||
                a.account.challengeId - b.account.challengeId,
            )
            .map((record) => (
              <CredentialRow key={record.address.toBase58()} record={record} />
            ))}
        </ul>
      )}
    </div>
  );
}

function CredentialRow({
  record,
}: {
  record: WalletSnapshot["credentials"][number];
}) {
  const challenge = findChallenge(record.account.challengeId);
  const address = record.address.toBase58();
  const explorer = addressExplorerHref(address);

  return (
    <li className="rounded-xl border border-border p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-medium">{challenge?.title ?? `Challenge #${record.account.challengeId}`}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {challenge?.category ?? "Unknown category"} ·{" "}
            {new Date(Number(record.account.issuedAt) * 1000).toISOString().slice(0, 10)}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-2xl tabular-nums">{record.account.score}</span>
          <StatusChip kind="pass" label="Pass" />
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
        <span className="text-muted-foreground">
          credential <MonoValue value={address} label="Credential address" />
        </span>
        <Link href={`/verify/${address}`} className="text-brand underline underline-offset-4">
          Public verification page
        </Link>
        {explorer && (
          <a
            href={explorer}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            Explorer
          </a>
        )}
      </div>
    </li>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-2 font-mono text-3xl tabular-nums">{value}</p>
    </div>
  );
}
