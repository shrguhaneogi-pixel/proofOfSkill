import { CopyButton } from "./copy-button";
import { cn } from "@/lib/utils";

/** Abbreviates a base58 address or hex digest as `ABCD…1234`. */
export function abbreviate(value: string, lead = 4, tail = 4): string {
  if (value.length <= lead + tail + 1) {
    return value;
  }
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

type MonoValueProps = {
  value: string;
  label: string;
  /** Render the whole string instead of the abbreviated form. */
  full?: boolean;
  className?: string;
};

/**
 * Monospace display for addresses, hashes and signatures. Colour is never the
 * only signal: the value itself and a copy control carry the meaning.
 */
export function MonoValue({ value, label, full = false, className }: MonoValueProps) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)} title={value}>
      <span className="font-mono text-sm tabular-nums" suppressHydrationWarning>
        {full ? value : abbreviate(value)}
      </span>
      <CopyButton value={value} label={label} />
    </span>
  );
}
