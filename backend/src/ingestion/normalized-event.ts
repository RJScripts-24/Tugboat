import type { CaseType, CustomerSegment } from "@prisma/client";

/**
 * One shape for everything that can put revenue at risk, whatever produced it.
 *
 * Razorpay webhooks and the simulator both normalize to this before the agent
 * sees anything, which is what lets the simulator be graded honestly (ADR-10):
 * it enters through the same door as reality, so the agent cannot tell them
 * apart, and no code path exists that only synthetic events can reach.
 */
export type NormalizedEvent = {
  /** De-duplication key. Razorpay's event id, or the simulator's own. */
  eventId: string;
  source: "razorpay" | "simulator";
  /** The provider's own event name, kept for the audit trail. */
  eventType: string;
  occurredAt: Date;

  caseType: CaseType;
  amountPaise: number;
  currency: string;

  origin: { kind: string; id: string; reference?: string };

  customer: {
    name: string;
    email?: string;
    phone?: string;
    languagePref?: string;
    segment?: CustomerSegment;
  };

  /** Absent for abandonment and overdue invoices — there is no gateway error to read. */
  failure?: { code?: string; reason?: string; source?: string; description?: string };

  instrument?: string;
  deadlineAt?: Date;

  /** The untouched provider payload, stored for replay and audit. */
  raw: unknown;
};
