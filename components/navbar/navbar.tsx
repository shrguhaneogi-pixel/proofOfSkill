import Link from "next/link";

import { WalletButton } from "@/components/wallet/wallet-button";

const LINKS = [
  { href: "/challenges", label: "Challenges" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/verify", label: "Verify" },
] as const;

export function Navbar() {
  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3">
        <Link
          href="/"
          className="flex items-center gap-2 font-semibold tracking-tight focus-visible:outline-2 focus-visible:outline-ring"
        >
          <span className="font-mono text-sm text-brand">{"<"}PoS{"/>"}</span>
          <span>ProofOfSkill</span>
        </Link>
        <nav aria-label="Main" className="flex items-center gap-1">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-surface hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              {link.label}
            </Link>
          ))}
          <WalletButton className="ml-2" />
        </nav>
      </div>
    </header>
  );
}
