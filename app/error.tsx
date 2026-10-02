"use client";

import Link from "next/link";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surfaced to the browser console for the developer; the user only ever
    // sees a plain-language explanation, never the message or digest.
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto max-w-2xl px-6 py-24 text-center">
      <p className="font-mono text-xs uppercase tracking-wide text-destructive">Something broke</p>
      <h1 className="mt-3 text-2xl font-semibold">This page hit an unexpected error</h1>
      <p className="mt-3 text-muted-foreground">
        Nothing was submitted or recorded. You can retry, or go back to the challenge list and start
        again.
      </p>
      <div className="mt-6 flex justify-center gap-3">
        <Button onClick={reset}>Try again</Button>
        <Button variant="outline" render={<Link href="/challenges" />}>
          Back to challenges
        </Button>
      </div>
    </div>
  );
}
