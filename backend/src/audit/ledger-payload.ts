import type { Case, CaseEvent, Customer, EventKind, LedgerActor } from "@prisma/client";

import { toCaseRef } from "../common/case-ref";
import type { PayloadValue } from "./ledger-seed";

/**
 * A timeline event, as a ledger row.
 *
 * Two rules from the frontend's own module note (`lib/audit-data.ts`), kept
 * because they are the reason the page is readable:
 *
 * 1. **Nothing here is a second copy of anything.** The payload is derived from
 *    the case event the Case Detail timeline renders, so the ledger and the
 *    story it is evidence for cannot drift apart. A separate audit store that
 *    agrees with the product most of the time is worse than no audit page.
 * 2. **Payloads are decision records, not archives.** A row records what was
 *    decided and what it was decided from, and references large artifacts — a
 *    call transcript, a message body — by shape rather than embedding them. A
 *    ledger you cannot read at a glance is a ledger nobody audits.
 */

/** The mapping the frontend already publishes (`AUDIT_MAP` in case-detail-data). */
export const AUDIT_MAP: Record<EventKind, { actor: LedgerActor; action: string }> = {
  DETECTED: { actor: "SYSTEM", action: "CASE_OPENED" },
  DIAGNOSED: { actor: "BOA", action: "DIAGNOSIS_WRITTEN" },
  PLANNED: { actor: "BOA", action: "ACTION_PLANNED" },
  POLICY_CHECK: { actor: "POLICY", action: "POLICY_EVALUATED" },
  EMAIL_SENT: { actor: "BOA", action: "ACTION_EXECUTED" },
  WHATSAPP_SENT: { actor: "BOA", action: "ACTION_EXECUTED" },
  VOICE_CALL: { actor: "BOA", action: "ACTION_EXECUTED" },
  RETRY_EXECUTED: { actor: "BOA", action: "ACTION_EXECUTED" },
  CUSTOMER_REPLY: { actor: "SYSTEM", action: "INBOUND_RECORDED" },
  PROMISE_RECORDED: { actor: "BOA", action: "PROMISE_RECORDED" },
  ESCALATED: { actor: "POLICY", action: "ESCALATION_RAISED" },
  APPROVAL_DECIDED: { actor: "HUMAN", action: "APPROVAL_DECIDED" },
  HALTED: { actor: "POLICY", action: "CONTACT_HALTED" },
  RECOVERED: { actor: "SYSTEM", action: "PAYMENT_CAPTURED" },
};

type FactRow = { label: string; value: unknown };

type EventBody = {
  type?: string;
  rows?: FactRow[];
  [key: string]: unknown;
};

/** "Attempt cap" -> "attempt_cap". Ledger keys are keys, not headings. */
function key(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

/**
 * The structured detail a timeline node carries, as ledger fields.
 *
 * The timeline already renders these rows to a human; converting them rather
 * than authoring a parallel set of payload fields is what keeps the two from
 * disagreeing.
 */
function factsOf(body: EventBody | null, skip: string[] = []): Record<string, PayloadValue> {
  if (!body?.rows) return {};

  const ignore = new Set(skip);
  const out: Record<string, PayloadValue> = {};

  for (const row of body.rows) {
    const name = key(row.label);
    // The recipient is already a field of its own. The same masked number twice
    // under two names is one of them going unflagged.
    if (ignore.has(name)) continue;
    out[name] = row.value as PayloadValue;
  }

  return out;
}

function asArray(value: unknown): PayloadValue[] {
  return Array.isArray(value) ? (value as PayloadValue[]) : [];
}

/**
 * The contact the channel actually addressed — masked, as it was stored.
 *
 * Masking happens where data enters the system (PRD 9.9), so the ledger is
 * reading an already-masked value rather than redacting on the way out. A row
 * that had to be masked at render time would already have been written in the
 * clear.
 */
function contactFor(kind: EventKind, customer: Customer): string {
  const masked = kind === "EMAIL_SENT" ? customer.maskedEmail : customer.maskedPhone;
  return masked ?? customer.maskedEmail ?? customer.maskedPhone ?? "—";
}

export function payloadFor(
  event: Pick<CaseEvent, "kind" | "title" | "summary" | "body">,
  record: Case,
  customer: Customer,
): PayloadValue {
  const body = (event.body ?? null) as EventBody | null;
  const base: Record<string, PayloadValue> = { case_id: toCaseRef(record.id) };
  const contact = contactFor(event.kind, customer);

  switch (event.kind) {
    case "DETECTED":
      return {
        ...base,
        type: record.type,
        source: record.originKind ?? "razorpay.webhook",
        amount_paise: record.amountPaise,
        currency: record.currency,
        customer: { name: customer.name, contact },
        ...factsOf(body),
      };

    case "DIAGNOSED":
      return {
        ...base,
        root_cause: record.rootCause,
        confidence: record.diagnosisConfidence,
        method: record.diagnosisMethod,
        rule_id: record.diagnosisRuleId,
        signals: asArray(body?.reasoning),
        ...factsOf(body),
      };

    case "PLANNED":
      return {
        ...base,
        chosen: (body?.chosen as PayloadValue) ?? event.summary,
        because: (body?.because as PayloadValue) ?? null,
        rejected: asArray(body?.rejected),
      };

    case "POLICY_CHECK":
      return {
        ...base,
        verdict: verdictOf(event.title),
        checks: asArray(body?.checks).map((check) => {
          const entry = check as { name?: string; verdict?: string; note?: string };
          return {
            name: entry.name ?? "",
            verdict: (entry.verdict ?? "").toUpperCase(),
            note: entry.note ?? "",
          };
        }),
      };

    case "EMAIL_SENT":
    case "WHATSAPP_SENT":
      return {
        ...base,
        channel: event.kind === "EMAIL_SENT" ? "EMAIL" : "WHATSAPP",
        recipient: contact,
        subject: (body?.subject as PayloadValue) ?? null,
        // Referenced by shape. A ledger that embeds every message it ever sent
        // is a ledger nobody can read.
        body_lines: asArray(body?.lines).length,
        payment_link: Boolean(body?.link),
        ...factsOf(body, ["to", "recipient"]),
      };

    case "VOICE_CALL":
      return {
        ...base,
        channel: "VOICE",
        recipient: contact,
        seconds: (body?.seconds as PayloadValue) ?? null,
        detected_intent: (body?.intent as PayloadValue) ?? null,
        transcript_turns: asArray(body?.transcript).length,
        ...factsOf(body, ["to", "recipient"]),
      };

    case "RETRY_EXECUTED":
      return {
        ...base,
        channel: "RETRY",
        silent: true,
        instrument: record.instrument ?? null,
        ...factsOf(body, ["instrument"]),
      };

    case "CUSTOMER_REPLY":
      return {
        ...base,
        channel: (body?.channel as PayloadValue) ?? "WHATSAPP",
        from: contact,
        sentiment: String((body?.sentiment as string) ?? "neutral").toUpperCase(),
        text: (body?.text as PayloadValue) ?? event.summary,
        ...factsOf(body, ["from"]),
      };

    case "PROMISE_RECORDED":
      return {
        ...base,
        amount_paise: (body?.amountPaise as PayloadValue) ?? record.amountPaise,
        due: (body?.dateLabel as PayloadValue) ?? null,
        days_away: (body?.daysAway as PayloadValue) ?? null,
        ...factsOf(body),
      };

    case "ESCALATED":
      return { ...base, queued_to: "approvals", reason: event.summary, ...factsOf(body) };

    case "APPROVAL_DECIDED":
      return { ...base, outcome: event.summary, ...factsOf(body) };

    case "HALTED":
      return {
        ...base,
        rule: event.title,
        scope: "ALL_CHANNELS",
        reversible: false,
        ...factsOf(body),
      };

    case "RECOVERED":
      return {
        ...base,
        amount_paise: record.recoveredAmountPaise || record.amountPaise,
        currency: record.currency,
        attempts: record.attemptsUsed,
        ...factsOf(body),
      };

    default:
      return { ...base, detail: event.summary };
  }
}

/**
 * A gate verdict, read from the entry the gate itself wrote.
 *
 * Three values rather than two: an approval is neither a pass nor a block, and
 * collapsing it into one of them would make the evidence report's escalation
 * count unrecoverable from the ledger.
 */
function verdictOf(title: string): string {
  const lower = title.toLowerCase();
  if (lower.includes("needs approval")) return "NEEDS_APPROVAL";
  if (lower.includes("blocked")) return "BLOCK";
  return "PASS";
}
