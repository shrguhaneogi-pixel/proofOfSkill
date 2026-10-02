"use client";

import { useWallet, type Wallet } from "@solana/wallet-adapter-react";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import { MonoValue } from "@/components/common/mono-value";
import { Button } from "@/components/ui/button";

type Props = { className?: string };

function describeWallets(wallets: Wallet[]): { label: string; available: boolean } {
  if (wallets.length === 0) {
    return { label: "No wallet detected", available: false };
  }
  const ready = wallets.filter((entry) => entry.readyState === WalletReadyState.Installed);
  const pool = ready.length > 0 ? ready : wallets;
  const phantom = pool.find((entry) => entry.adapter.name.toLowerCase().includes("phantom"));
  const name = phantom ? phantom.adapter.name : pool[0].adapter.name;
  return { label: name, available: true };
}

export function WalletButton({ className }: Props): ReactNode {
  const { wallets, wallet, connecting, connected, publicKey, select, connect, disconnect } =
    useWallet();
  const [error, setError] = useState<string | null>(null);

  const detected = useMemo(() => describeWallets(wallets), [wallets]);

  const handleConnect = useCallback(async () => {
    setError(null);
    if (wallets.length === 0) {
      setError("Install Phantom or another Solana wallet to continue.");
      return;
    }
    try {
      if (!wallet) {
        select(wallets[0].adapter.name);
      }
      await connect();
    } catch (connectError) {
      const name = connectError instanceof Error ? connectError.name : "";
      if (name === "WalletUserRejectedError" || name === "UserRejectedRequestError") {
        setError("You cancelled the connection request.");
      } else if (name === "WalletNotReadyError") {
        setError("The selected wallet is not installed or not ready.");
      } else {
        setError("Could not connect. Open your wallet and approve the request.");
      }
    }
  }, [connect, select, wallet, wallets]);

  if (connected && publicKey) {
    return (
      <div className={className}>
        <div className="flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-1.5">
          <span className="size-2 shrink-0 rounded-full bg-success" aria-hidden />
          <MonoValue value={publicKey.toBase58()} label="Wallet address" />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void disconnect();
            }}
          >
            Disconnect
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={className}>
      <div className="flex items-center gap-2">
        <Button
          onClick={() => void handleConnect()}
          disabled={connecting || !detected.available}
          variant={detected.available ? "default" : "outline"}
          size="sm"
        >
          {connecting ? "Connecting…" : detected.available ? `Connect ${detected.label}` : "Wallet not found"}
        </Button>
        {!detected.available && (
          <a
            href="https://www.phantom.com/download"
            target="_blank"
            rel="noreferrer"
            className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            Install Phantom
          </a>
        )}
      </div>
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  );
}
