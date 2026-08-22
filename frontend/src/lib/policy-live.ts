"use client";

import { useSyncExternalStore } from "react";

/**
 * The policy version in force, shared with the shell.
 *
 * The top bar renders "policy v4" on the server, and then a merchant saves a
 * change on the Policies page and it is v5 - on that page, in the ledger, and
 * in every gate decision from that moment. A header still saying v4 is a small
 * lie in the one place the product is claiming to be exact about versions.
 *
 * Same shape as `lib/approvals-live` and for the same reason: one value
 * crossing two component trees is a store, not a prop. `getServerSnapshot`
 * returns the server's own figure so the first client render matches the
 * markup it is hydrating.
 */
let live: string | null = null;

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Called by the Policies page when a save writes a new revision. */
export function setPolicyVersion(next: string): void {
  if (next === live) return;
  live = next;
  for (const listener of listeners) listener();
}

export function usePolicyVersion(initial: string): string {
  return useSyncExternalStore(
    subscribe,
    () => live ?? initial,
    () => initial,
  );
}
