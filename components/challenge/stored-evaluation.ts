"use client";

import { useSyncExternalStore } from "react";

import type { EvaluationResult } from "@/lib/evaluation/types";

/**
 * The evaluation plus the HMAC attestation the route mints for an issuable pass.
 * `attestation` is deliberately absent from `EvaluationResult` itself, so the
 * evaluator module cannot mint its own authorisation.
 */
export type StoredEvaluation = EvaluationResult & { attestation?: string };

const STORAGE_PREFIX = "proofofskill:evaluation:";

function storageKey(challengeId: number): string {
  return `${STORAGE_PREFIX}${challengeId}`;
}

const listeners = new Set<() => void>();

/**
 * Parsed values are cached by their raw JSON so `getSnapshot` returns the same
 * object reference between reads. Returning a fresh object each call would make
 * `useSyncExternalStore` re-render forever.
 */
const cache = new Map<string, { raw: string; value: StoredEvaluation | null }>();

function parseInto(key: string, raw: string | null): StoredEvaluation | null {
  if (raw === null) {
    cache.set(key, { raw: "", value: null });
    return null;
  }
  const cached = cache.get(key);
  if (cached && cached.raw === raw) {
    return cached.value;
  }
  try {
    const value = JSON.parse(raw) as StoredEvaluation;
    cache.set(key, { raw, value });
    return value;
  } catch {
    // A corrupt entry is removed rather than surfacing as a crash or silently
    // keeping a mismatched evaluation for another challenge.
    window.sessionStorage.removeItem(key);
    cache.set(key, { raw: "", value: null });
    return null;
  }
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function getServerSnapshot(): StoredEvaluation | null {
  return null;
}

/**
 * Reads the evaluation for this challenge out of sessionStorage. The MVP keeps
 * no server state (docs/architecture.md → OFFCHAIN_PERSISTENCE), so this is what
 * lets a refresh keep the result without inventing a database.
 */
export function useStoredEvaluation(challengeId: number): StoredEvaluation | null {
  const key = storageKey(challengeId);
  return useSyncExternalStore(
    subscribe,
    () => parseInto(key, window.sessionStorage.getItem(key)),
    getServerSnapshot,
  );
}

export function writeStoredEvaluation(evaluation: StoredEvaluation): void {
  if (evaluation.challengeId < 1 || evaluation.challengeId > 5) {
    throw new Error("evaluation references an unknown challenge id");
  }
  window.sessionStorage.setItem(storageKey(evaluation.challengeId), JSON.stringify(evaluation));
  for (const listener of listeners) {
    listener();
  }
}

export function clearStoredEvaluation(challengeId: number): void {
  window.sessionStorage.removeItem(storageKey(challengeId));
  cache.delete(storageKey(challengeId));
  for (const listener of listeners) {
    listener();
  }
}
