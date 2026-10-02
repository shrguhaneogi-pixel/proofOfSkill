"use client";

import dynamic from "next/dynamic";
import { useReducedMotion } from "motion/react";
import { useSyncExternalStore } from "react";

const CredentialScene = dynamic(
  () => import("./credential-scene").then((module) => module.CredentialScene),
  { ssr: false, loading: () => <HeroFallback /> },
);

function detectWebgl(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

// Probed once and cached: `getSnapshot` must stay referentially stable so React
// does not re-render on every call, and creating a canvas per render is waste.
let webglCache: boolean | undefined;
function getWebglSnapshot(): boolean {
  webglCache ??= detectWebgl();
  return webglCache;
}
function getWebglServerSnapshot(): boolean {
  return false;
}
function subscribeToNothing(): () => void {
  return () => {};
}

/**
 * Static representation of the same idea, used for `prefers-reduced-motion`,
 * missing WebGL, and the server pass before the client decides.
 */
export function HeroFallback() {
  return (
    <svg
      viewBox="0 0 260 170"
      role="img"
      aria-label="Illustration of a verified skill credential"
      className="h-full w-full"
    >
      <defs>
        <linearGradient id="pos-card" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#1d2433" />
          <stop offset="100%" stopColor="#11151f" />
        </linearGradient>
      </defs>
      <rect
        x="18"
        y="24"
        width="224"
        height="122"
        rx="14"
        fill="url(#pos-card)"
        stroke="rgba(255,255,255,0.14)"
      />
      <rect x="44" y="52" width="112" height="9" rx="4.5" fill="#5b8cff" />
      <rect x="44" y="74" width="76" height="7" rx="3.5" fill="#8f9bb0" />
      <rect x="44" y="90" width="150" height="7" rx="3.5" fill="#39414f" />
      <circle cx="206" cy="112" r="15" fill="none" stroke="#3fbf7f" strokeWidth="3" />
      <path d="M199 112l5 5 9-10" fill="none" stroke="#3fbf7f" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function HeroVisual() {
  const reduceMotion = useReducedMotion();
  const webgl = useSyncExternalStore(subscribeToNothing, getWebglSnapshot, getWebglServerSnapshot);

  if (reduceMotion || !webgl) {
    return (
      <div className="aspect-[26/17] w-full rounded-xl border border-border bg-surface p-6">
        <HeroFallback />
      </div>
    );
  }

  return (
    <div className="aspect-[26/17] w-full overflow-hidden rounded-xl border border-border bg-surface">
      <CredentialScene />
    </div>
  );
}
