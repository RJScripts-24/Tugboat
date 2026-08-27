/**
 * The Recovery Pipeline (PRD 6.3, page 3).
 *
 * This file used to hold the whole seeded batch — 214 cases generated from a
 * fixed PRNG so the funnel, the root-cause table and the case list could not
 * disagree with each other. They cannot disagree now for a better reason: there
 * is one batch, it is in Postgres, and every figure on every page is a query
 * against it.
 *
 * What survives is the part that was always a contract rather than data: the
 * canonical vocabularies (`CaseType`, `RootCause`, `Stage`), the metadata that
 * decides how each value is labelled and toned, and the amount bands the filter
 * bar offers. Those are shared by the API and the UI, and they stay here because
 * this is where every component already imports them from.
 */

import type { Tone } from "./dashboard-data";

const RUPEE = 100;
/* ------------------------------------------------------------------ */
/* Vocabulary                                                          */
/* ------------------------------------------------------------------ */

export type CaseType =
  | "PAYMENT_FAILED"
  | "CHECKOUT_ABANDONED"
  | "MANDATE_FAILED"
  | "INVOICE_OVERDUE";

export type RootCause =
  | "BANK_GATEWAY_DEGRADED"
  | "INSUFFICIENT_FUNDS"
  | "CUSTOMER_DISTRACTED"
  | "CARD_EXPIRED"
  | "MANDATE_REVOKED"
  | "UNKNOWN";

/** The case state machine's states (ADR-3), lower-cased for use in URLs. */
export type Stage =
  | "detected"
  | "diagnosed"
  | "intervening"
  | "waiting"
  | "escalated"
  | "promised"
  | "recovered"
  | "halted"
  | "exhausted";

export type PipelineCase = {
  id: string;
  type: CaseType;
  customer: string;
  /** Masked, always - the pipeline is a screen-share surface. */
  contact: string;
  amountPaise: number;
  rootCause: RootCause;
  /** Null while the case is still queued for diagnosis. */
  confidence: number | null;
  method: "RULES" | "LLM" | null;
  stage: Stage;
  nextAction: string;
  attempts: number;
  attemptCap: number;
  /**
   * Age of the last event, in minutes. Stored rather than a timestamp so the
   * relative label is identical on the server and the client - a `Date.now()`
   * here would be a hydration mismatch on every load.
   */
  updatedMinutesAgo: number;
  recoveredPaise: number;
};

/* ------------------------------------------------------------------ */
/* Stage metadata                                                      */
/* ------------------------------------------------------------------ */

/**
 * `group` is what the money means, not how it looks: `open` is still in flight,
 * `closed` is finished without the money. The root-cause table's "still open"
 * figure on the Control Tower is exactly the `open` group summed by cause.
 *
 * Tones repeat on purpose. A promise and an escalation are both "in flight,
 * needs watching", so both are amber rather than each earning a colour of its
 * own, and green stays reserved for recovered money.
 */
export const STAGE_META: Record<
  Stage,
  { label: string; tone: Tone; pulsing?: boolean; group: "open" | "recovered" | "closed" }
> = {
  detected: { label: "Detected", tone: "neutral", group: "open" },
  diagnosed: { label: "Diagnosed", tone: "diagnosis", group: "open" },
  intervening: { label: "Intervening", tone: "waiting", pulsing: true, group: "open" },
  waiting: { label: "Waiting", tone: "neutral", group: "open" },
  escalated: { label: "Escalated", tone: "waiting", group: "open" },
  promised: { label: "Committed", tone: "waiting", group: "open" },
  recovered: { label: "Recovered", tone: "recovered", group: "recovered" },
  halted: { label: "Halted", tone: "halted", group: "closed" },
  exhausted: { label: "Exhausted", tone: "neutral", group: "closed" },
};

/** Filter order: in flight first, outcomes last - the order an operator triages. */
export const STAGE_ORDER: Stage[] = [
  "detected",
  "diagnosed",
  "intervening",
  "waiting",
  "escalated",
  "promised",
  "recovered",
  "halted",
  "exhausted",
];

export const CASE_TYPE_META: Record<CaseType, { label: string; short: string }> = {
  PAYMENT_FAILED: { label: "Payment failed", short: "Payment" },
  CHECKOUT_ABANDONED: { label: "Checkout abandoned", short: "Checkout" },
  MANDATE_FAILED: { label: "Mandate failed", short: "Mandate" },
  INVOICE_OVERDUE: { label: "Invoice overdue", short: "Invoice" },
};

export const CASE_TYPE_ORDER: CaseType[] = [
  "PAYMENT_FAILED",
  "CHECKOUT_ABANDONED",
  "MANDATE_FAILED",
  "INVOICE_OVERDUE",
];

export const ROOT_CAUSE_META: Record<RootCause, { label: string; tone: Tone }> = {
  BANK_GATEWAY_DEGRADED: { label: "Bank gateway degraded", tone: "diagnosis" },
  INSUFFICIENT_FUNDS: { label: "Insufficient funds", tone: "waiting" },
  CUSTOMER_DISTRACTED: { label: "Customer distracted", tone: "neutral" },
  CARD_EXPIRED: { label: "Card expired", tone: "diagnosis" },
  MANDATE_REVOKED: { label: "Mandate revoked", tone: "halted" },
  UNKNOWN: { label: "Unknown", tone: "neutral" },
};

export const ROOT_CAUSE_ORDER: RootCause[] = [
  "BANK_GATEWAY_DEGRADED",
  "INSUFFICIENT_FUNDS",
  "CUSTOMER_DISTRACTED",
  "CARD_EXPIRED",
  "MANDATE_REVOKED",
  "UNKNOWN",
];

/** Bands, not two number inputs: nobody types rupee bounds while triaging. */
export const AMOUNT_BANDS = [
  { key: "lt1k", label: "Under ₹1,000", min: 0, max: 1_000 * RUPEE },
  { key: "1k5k", label: "₹1,000 – ₹5,000", min: 1_000 * RUPEE, max: 5_000 * RUPEE },
  { key: "5k25k", label: "₹5,000 – ₹25,000", min: 5_000 * RUPEE, max: 25_000 * RUPEE },
  { key: "gt25k", label: "Over ₹25,000", min: 25_000 * RUPEE, max: Number.MAX_SAFE_INTEGER },
] as const;

export type AmountBandKey = (typeof AMOUNT_BANDS)[number]["key"];

/* ------------------------------------------------------------------ */
/* GET /cases                                                          */
/* ------------------------------------------------------------------ */

export type CaseFilters = {
  stage?: Stage[];
  type?: CaseType[];
  cause?: RootCause[];
  search?: string;
  minPaise?: number;
  maxPaise?: number;
  skip?: number;
  take?: number;
};

/* ------------------------------------------------------------------ */
/* Presentation helpers                                                */
/* ------------------------------------------------------------------ */

/** Relative, coarse, and computed from a stored offset so SSR can render it. */
export function formatAge(minutes: number): string {
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1_440) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1_440)}d ago`;
}
