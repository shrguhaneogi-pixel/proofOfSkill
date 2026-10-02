"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { parsePublicKey } from "@/lib/solana/codecs";

export default function VerifyLookupPage() {
  const router = useRouter();
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = address.trim();
    const parsed = parsePublicKey(trimmed);
    if (!parsed.ok) {
      setError("That is not a valid Solana address. Paste the credential address from your dashboard.");
      return;
    }
    router.push(`/verify/${parsed.data.toBase58()}`);
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Verify a credential</h1>
      <p className="mt-3 text-muted-foreground">
        Paste a credential account address. The page reads that account directly from Solana, so what
        you see is what the network holds — no database in between.
      </p>

      <form onSubmit={submit} className="mt-8 space-y-3">
        <Label htmlFor="credential">Credential address</Label>
        <Input
          id="credential"
          value={address}
          onChange={(event) => {
            setAddress(event.target.value);
            setError(null);
          }}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={error !== null}
          aria-describedby={error ? "credential-error" : undefined}
          placeholder="4JzYzqr1CMNmntfSpatBngb9uHGYQqoJfyXkyn6rARKW"
          className="font-mono text-sm"
        />
        {error && (
          <p id="credential-error" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit">Look up on Solana</Button>
      </form>
    </div>
  );
}
