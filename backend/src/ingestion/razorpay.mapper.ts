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
  return SUCCESS_EVENTS.has(event);
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

  const notes = (entity.notes ?? {}) as Record<string, unknown>;
  const email = str(entity.email) ?? str(notes.email);
  const phone = str(entity.contact) ?? str(notes.phone);

  return {
    eventId,
    source: "razorpay",
    eventType,
    occurredAt: body.created_at ? new Date(body.created_at * 1000) : new Date(),
    caseType,
    amountPaise: num(entity.amount) ?? num(entity.amount_due) ?? 0,
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
