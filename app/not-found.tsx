import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-24 text-center">
      <p className="font-mono text-xs uppercase tracking-wide text-muted-foreground">404</p>
      <h1 className="mt-3 text-2xl font-semibold">Not found</h1>
      <p className="mt-3 text-muted-foreground">
        There is no challenge, credential or page at that address. A credential URL must be the exact
        base58 address of a credential account on Devnet.
      </p>
      <div className="mt-6 flex justify-center gap-3">
        <Button render={<Link href="/challenges" />}>Browse challenges</Button>
        <Button variant="outline" render={<Link href="/" />}>
          Home
        </Button>
      </div>
    </div>
  );
}
