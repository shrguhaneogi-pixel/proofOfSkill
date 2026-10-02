"use client";

import { useCallback, useState } from "react";

import { cn } from "@/lib/utils";

type CopyButtonProps = {
  value: string;
  label: string;
  className?: string;
};

/**
 * Copy affordance for addresses and hashes. The full value is always available
 * to assistive tech and on hover, never only as a truncated string.
 */
export function CopyButton({ value, label, className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard permission denied or insecure context: the full value is
      // still rendered in the title, so there is nothing to recover from.
      setCopied(false);
    }
  }, [value]);

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      title={value}
      className={cn(
        "rounded-sm border border-transparent px-1.5 py-0.5 font-mono text-[0.6875rem] text-muted-foreground",
        "transition-colors hover:border-border hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
        className,
      )}
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}
