/**
 * Cases are stored under an integer primary key and addressed everywhere else
 * as "C-<id>" — the reference the Control Tower puts in URLs and the ledger
 * uses as a chain name. Both directions live here so no other module invents
 * its own parsing.
 */

const CASE_REF = /^C-(\d+)$/;

export function toCaseRef(id: number): string {
  return `C-${id}`;
}

/** Returns null rather than throwing: callers turn that into a 404, not a 500. */
export function parseCaseRef(ref: string): number | null {
  const match = CASE_REF.exec(ref.trim());
  if (!match) return null;

  const id = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
