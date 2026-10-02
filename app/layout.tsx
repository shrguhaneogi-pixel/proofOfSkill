import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { Navbar } from "@/components/navbar/navbar";
import { WalletProviders } from "@/components/wallet/wallet-providers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "ProofOfSkill — verifiable onchain skill credentials",
    template: "%s · ProofOfSkill",
  },
  description:
    "Complete a technical challenge, get a rubric-based AI evaluation, and have a passing result recorded on Solana as a portable, publicly verifiable credential.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} dark h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="flex min-h-full flex-col bg-background text-foreground">
        <WalletProviders>
          <Navbar />
          <main className="flex-1">{children}</main>
          <footer className="border-t border-border/60">
            <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-6 py-5 text-xs text-muted-foreground">
              <span>ProofOfSkill · Skill → Evaluation → Verification → Reputation</span>
              <span className="font-mono">AI Evaluation ≠ Onchain Verification</span>
            </div>
          </footer>
        </WalletProviders>
      </body>
    </html>
  );
}
