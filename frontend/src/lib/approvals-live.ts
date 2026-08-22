"use client";

import { useSyncExternalStore } from "react";

/**
 * The pending count, shared with the shell.
 *
 * The sidebar badge is rendered on the server from the seeded queue, but the
 * queue moves while a demo is running: a case escalates and the badge has to
 * tick up in real time (PRD 6.3, page 5), and a decision has to take it back
 * down. That is one number crossing two component trees, which is a store -
 * not a prop, and not a refetch.
 *
 * Deliberately the smallest one that works: a module-level integer and a set
 * of listeners. `getServerSnapshot` returns the server's own figure, so the
 * first client render matches the markup it is hydrating and the badge never
 * flickers on load.
 */
let live: number | null = null;

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Called by the Approvals Queue whenever its own pending count changes. */
export function setPendingApprovals(next: number): void {
  if (next === live) return;
  live = next;
  for (const listener of listeners) listener();
}

export function usePendingApprovals(initial: number): number {
  return useSyncExternalStore(
    subscribe,
    () => live ?? initial,
    () => initial,
  );
}
