"use client";

import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";

const DEVNET_RPC = "https://api.devnet.solana.com";

function resolveEndpoint(): string {
  const configured = process.env.NEXT_PUBLIC_SOLANA_RPC_URL;
  return configured && configured.length > 0 ? configured : DEVNET_RPC;
}

/**
 * `wallets` is intentionally empty: @solana/wallet-adapter-react 0.15.40 calls
 * `useStandardWalletAdapters` internally, so Phantom and any other Wallet
 * Standard wallet present in the browser are discovered automatically. Explicit
 * adapters are only needed if detection proves unreliable — see docs/stack.md.
 */
export function WalletProviders({ children }: { children: React.ReactNode }) {
  const endpoint = resolveEndpoint();

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={[]} autoConnect>
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
}
