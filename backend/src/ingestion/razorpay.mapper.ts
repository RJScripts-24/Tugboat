import { createHash } from "node:crypto";

import type { CaseType } from "@prisma/client";

import type { NormalizedEvent } from "./normalized-event";

/**
 * Which Razorpay events open a case, and as what.
 *
 * Anything absent is acknowledged and stored but opens nothing — a webhook
 * endpoint that 500s on an event type it does not care about teaches the
 * provider to retry forever.
 */
const EVENT_TO_CASE_TYPE: Record<string, CaseType> = {
  "payment.failed": "PAYMENT_FAILED",
  "subscription.halted": "MANDATE_FAILED",
  "subscription.pending": "MANDATE_FAILED",
  "subscription.charged.failed": "MANDATE_FAILED",
  "invoice.expired": "INVOICE_OVERDUE",
  "payment_link.expired": "CHECKOUT_ABANDONED",
};

/**
 * Successes open nothing, but they are the denominator the degradation detector
 * needs: a run of failures is only alarming next to how many payments went
 * through beside them.
 */
const SUCCESS_EVENTS = new Set(["payment.captured", "order.paid", "subscription.charged"]);

export function isSuccessEvent(event: string): boolean {
  return SUCCESS_EVENTS.has(event) || event === "payment_link.paid";
}

/**
 * A success that names one of our cases is a recovery, not just a sample.
 *
 * Every link the real lane issues carries `notes.tugboat_case` and a
 * `reference_id` of the case reference (D-123), and Razorpay echoes both back
 * on `payment_link.paid` and on the `payment.captured` behind it. Either is
 * enough; a success that names no case is recorded as a sample only, which is
 * what an unrelated payment on the same account should be.
 */
export function paymentArrivalOf(
  body: RazorpayWebhook,
  eventId: string,
): {
  eventId: string;
  caseId: number;
  amountPaise: number;
  reference: string;
  via: string;
  at?: Date;
  raw: unknown;
} | null {
  const payload = body.payload ?? {};
  const payment = payload.payment?.entity ?? {};
  const link = payload.payment_link?.entity ?? {};

  const notes = { ...((link.notes ?? {}) as Record<string, unknown>), ...((payment.notes ?? {}) as Record<string, unknown>) };
  const named = str(notes.tugboat_case) ?? str(link.reference_id);
  const caseId = named ? caseIdFromRef(named) : null;
  if (caseId === null) return null;

  const paymentId = str(payment.id) ?? str(link.id);
  if (!paymentId) return null;

  return {
    eventId,
    caseId,
    amountPaise: num(payment.amount) ?? num(link.amount_paid) ?? num(link.amount) ?? 0,
    reference: paymentId,
    via: body.event === "payment_link.paid" ? "Paid from the payment link · Razorpay" : "Payment captured · Razorpay",
    at: body.created_at ? new Date(body.created_at * 1000) : undefined,
    raw: body,
  };
}

/** "C-1042" → 1042; anything else → null. Deliberately strict: a note is untrusted input. */
function caseIdFromRef(value: string): number | null {
  const match = /^C-(\d{1,9})$/.exec(value.trim());
  return match ? Number(match[1]) : null;
}

const ORIGIN_KIND: Record<CaseType, string> = {
  PAYMENT_FAILED: "Razorpay payment",
  CHECKOUT_ABANDONED: "Razorpay order",
  MANDATE_FAILED: "Razorpay subscription",
  INVOICE_OVERDUE: "Razorpay invoice",
};

type RazorpayEntity = Record<string, unknown>;

type RazorpayWebhook = {
  event?: string;
  created_at?: number;
  payload?: Record<string, { entity?: RazorpayEntity }>;
};

export function caseTypeForEvent(event: string): CaseType | null {
  return EVENT_TO_CASE_TYPE[event] ?? null;
}

/** Razorpay sends the id in a header; falling back to a body digest keeps the dedupe key stable. */
export function razorpayEventId(header: string | undefined, rawBody: Buffer | string): string {
  if (header && header.trim()) return header.trim();
  return `sha256:${createHash("sha256").update(rawBody).digest("hex").slice(0, 32)}`;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Maps a verified Razorpay webhook to the internal event shape.
 *
 * Returns null for event types this product does not act on, which the caller
 * turns into a 200 — acknowledged, stored, ignored.
 */
export function normalizeRazorpayWebhook(
  body: RazorpayWebhook,
  eventId: string,
): NormalizedEvent | null {
  const eventType = str(body.event);
  if (!eventType) return null;

  const caseType = caseTypeForEvent(eventType);
  if (!caseType) return null;

  // The payload is keyed by entity name ("payment", "subscription", "invoice");
  // which one is present depends on the event, so take the first that has one.
  const entity =
    Object.values(body.payload ?? {})
      .map((wrapper) => wrapper?.entity)
      .find((value): value is RazorpayEntity => Boolean(value)) ?? {};

  const id = str(entity.id);
  if (!id) return null;

  // A signed event with no readable amount is not a case. Opening one at ₹0
  // would have the agent retrying and messaging a customer about nothing
  // (B-56); the delivery is acknowledged and recorded, not worked.
  const amountPaise = num(entity.amount) ?? num(entity.amount_due) ?? 0;
  if (amountPaise <= 0) return null;

  const notes = (entity.notes && typeof entity.notes === "object" ? entity.notes : {}) as Record<
    string,
    unknown
  >;
  const email = str(entity.email) ?? str(notes.email);
  const phone = str(entity.contact) ?? str(notes.phone);

  return {
    eventId,
    source: "razorpay",
    eventType,
    occurredAt: body.created_at ? new Date(body.created_at * 1000) : new Date(),
    caseType,
    amountPaise,
    currency: str(entity.currency) ?? "INR",
    origin: {
      kind: ORIGIN_KIND[caseType],
      id,
      reference: str(entity.receipt) ?? str(entity.invoice_number),
    },
    customer: {
      name: str(notes.name) ?? str(entity.customer_name) ?? email ?? phone ?? "Unknown customer",
      email,
      phone,
      languagePref: str(notes.language),
    },
    failure: {
      code: str(entity.error_code),
      reason: str(entity.error_reason),
      source: str(entity.error_source),
      description: str(entity.error_description),
    },
    instrument: str(entity.method),
    raw: body,
  };
}
