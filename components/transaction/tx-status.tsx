"use client";

import Link from "next/link";

import { MonoValue } from "@/components/common/mono-value";
import { StatusChip } from "@/components/common/status-chip";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { transactionExplorerHref } from "@/lib/solana/explorer";

import type { TxState } from "./tx-machine";

const COPY: Record<TxState["status"], { title: string; detail: string; progress: number }> = {
  disconnected: {
    title: "Wallet not connected",
    detail: "Connect Phantom on Devnet to issue this credential.",
    progress: 5,
  },
  connecting: {
    title: "Connecting wallet",
    detail: "Approve the connection request in your wallet.",
    progress: 15,
  },
  connected: {
    title: "Ready to issue",
    detail: "The server builds the transaction and co-signs it as the registered issuer.",
    progress: 25,
  },
  preparing: {
    title: "Preparing transaction",
    detail: "Requesting the issuer co-signature and a recent blockhash.",
    progress: 40,
  },
  signing: {
    title: "Waiting for your signature",
    detail: "Approve the request in Phantom. Nothing is recorded until you sign.",
    progress: 55,
  },
  submitted: {
    title: "Sent to the network",
    detail: "Transaction submitted. Waiting for confirmation.",
    progress: 75,
  },
  confirming: {
    title: "Confirming on Devnet",
    detail: "Waiting for the cluster to confirm against the blockhash we were given.",
    progress: 90,
  },
  success: {
    title: "Credential recorded onchain",
    detail: "The credential account now exists on Solana Devnet and is publicly verifiable.",
    progress: 100,
  },
  failed: {
    title: "Not recorded",
    detail: "The transaction did not succeed. No credential was created.",
    progress: 100,
  },
};

export function TransactionStatus({
  state,
  onRetry,
  credentialPda,
}: {
  state: TxState;
  onRetry: () => void;
  credentialPda?: string;
}) {
  const copy = COPY[state.status];
  const signature = "signature" in state ? state.signature : undefined;
  const explorerHref = signature ? transactionExplorerHref(signature) : undefined;
  const failed = state.status === "failed";

  return (
    <section
      aria-live="polite"
      className={`space-y-4 rounded-xl border p-5 ${
        failed ? "border-destructive/50 bg-destructive/5" : "border-border bg-card"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip
          kind={state.status === "success" ? "onchain-verified" : failed ? "fail" : "pending"}
          label={state.status === "success" ? "Onchain Verified" : failed ? "Failed" : "In progress"}
        />
        {failed && <span className="font-mono text-xs text-destructive">{state.code}</span>}
      </div>

      <div>
        <h3 className="text-base font-semibold">{copy.title}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{copy.detail}</p>
        {failed && <p className="mt-2 text-sm">{state.message}</p>}
      </div>

      <Progress value={copy.progress} className="h-1.5" />

      {signature && (
        <div className="space-y-1 text-sm">
          <p className="text-muted-foreground">
            Signature <MonoValue value={signature} label="Transaction signature" />
          </p>
          {explorerHref && (
            <p>
              <a
                href={explorerHref}
                target="_blank"
                rel="noreferrer"
                className="text-brand underline underline-offset-4"
              >
                View on Solana Explorer
              </a>
            </p>
          )}
        </div>
      )}

      {state.status === "success" && credentialPda && (
        <div className="space-y-1 text-sm">
          <p className="text-muted-foreground">
            Credential account <MonoValue value={credentialPda} label="Credential address" />
          </p>
          <Button
            size="sm"
            variant="outline"
            render={<Link href={`/verify/${credentialPda}`} />}
          >
            Open public verification page
          </Button>
        </div>
      )}

      {failed && state.retryable && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      )}
    </section>
  );
}
