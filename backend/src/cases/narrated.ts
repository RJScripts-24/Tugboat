import type { Prisma } from "@prisma/client";

/**
 * The cases the Control Tower narrates.
 *
 * Live cases — the ones that arrived through a webhook — and the cases of the
 * one simulation run the merchant has promoted (D-94). Nothing else. A batch
 * running in the Lab, or one that finished and was never promoted, is an
 * experiment: its cases, its approvals and its recoveries belong to its
 * evidence report and to nothing on the operational pages. Without this clause
 * every dashboard figure was a sum over every batch ever run — the headline
 * read 1,528 cases at 19% while the promoted report said 214 at 36% (B-44,
 * D-120).
 *
 * A `where` fragment rather than a query, so every read spells the rule the
 * same way and none can forget it. Spread it into a case query, or nest it
 * under a relation: `case: narratedCases(merchantId)`.
 *
 * Deliberately not applied to the audit ledger. The ledger is the record of
 * everything that was ever done, promoted or not, and a ledger that hides rows
 * by scope is a ledger with a filter somebody could point at.
 */
export function narratedCases(merchantId: string): Prisma.CaseWhereInput {
  return {
    merchantId,
    OR: [{ simRunId: null }, { simRun: { promotedAt: { not: null } } }],
  };
}
