import type { CaseEvent, EventKind } from "@prisma/client";

import { toCaseRef } from "../common/case-ref";
import type { ActivityActor, ActivityEntry, ActivityKind } from "../common/domain-event";

/**
 * A case event, as a line in the Boa activity log.
 *
 * Derived from the timeline entry rather than authored beside it, for the same
 * reason the ledger payload is (D-73): a feed with its own copywriting is a
 * second account of the same events, and the two disagree the first time
 * somebody edits one. The log's two lines are the event's own `title` and
 * `summary` — the strings the Case Detail timeline is already rendering — so a
 * line in the feed and the entry it links to say the same thing by
 * construction.
 */

const KIND_TO_ACTIVITY: Record<EventKind, ActivityKind> = {
  DETECTED: "DETECT",
  DIAGNOSED: "DIAGNOSE",
  // A plan is Boa deciding, which is worth showing: it is the line before every
  // policy check, and a feed that jumped from diagnosis to send would hide the
  // step where the alternatives were rejected.
  PLANNED: "POLICY",
  POLICY_CHECK: "POLICY",
  EMAIL_SENT: "MESSAGE",
  WHATSAPP_SENT: "MESSAGE",
  DELIVERY_FAILED: "POLICY_BLOCK",
  VOICE_CALL: "CALL",
  RETRY_EXECUTED: "RETRY",
  CUSTOMER_REPLY: "MESSAGE",
  PROMISE_RECORDED: "PROMISE",
  ESCALATED: "ESCALATE",
  APPROVAL_DECIDED: "ESCALATE",
  HALTED: "HALT",
  RECOVERED: "RECOVERED",
};

const KIND_TO_ACTOR: Record<EventKind, ActivityActor> = {
  DETECTED: "BOA",
  DIAGNOSED: "BOA",
  PLANNED: "BOA",
  POLICY_CHECK: "POLICY",
  EMAIL_SENT: "BOA",
  WHATSAPP_SENT: "BOA",
  DELIVERY_FAILED: "POLICY",
  VOICE_CALL: "BOA",
  RETRY_EXECUTED: "BOA",
  CUSTOMER_REPLY: "BOA",
  PROMISE_RECORDED: "BOA",
  ESCALATED: "POLICY",
  APPROVAL_DECIDED: "POLICY",
  HALTED: "POLICY",
  RECOVERED: "RECOVERY",
};

/**
 * `hourCycle: "h23"` rather than `hour12: false`.
 *
 * They are not the same thing. With `hour12: false` the en-IN locale resolves
 * to the h24 cycle, which spells midnight "24:00:00" — so every line the feed
 * printed between 00:00 and 01:00 IST would have been stamped an hour that does
 * not exist, sorted after 23:59, and looked like tomorrow (B-42).
 */
const IST_CLOCK = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** HH:MM:SS in IST, stamped once by the writer so every reader shows the same string. */
export function istClock(at: Date): string {
  return IST_CLOCK.format(at);
}

type FeedEvent = Pick<CaseEvent, "id" | "kind" | "title" | "summary" | "badgeLabel" | "occurredAt">;

export function toActivityEntry(event: FeedEvent, caseId: number): ActivityEntry {
  const ref = toCaseRef(caseId);

  return {
    // The event row's own id. A feed that minted its own would hand the browser
    // two React keys for one event when a reconnect replays the tail.
    id: `ev-${event.id}`,
    kind: activityKind(event),
    actor: KIND_TO_ACTOR[event.kind],
    caseId: ref,
    title: event.title.includes(ref) ? event.title : `${event.title} ${ref}`,
    meta: event.summary,
    time: istClock(event.occurredAt),
  };
}

/**
 * A policy check that stopped something reads differently from one that let it
 * through, and the badge the gate already wrote is what says which.
 */
function activityKind(event: FeedEvent): ActivityKind {
  if (event.kind === "POLICY_CHECK" && event.badgeLabel === "BLOCKED") return "POLICY_BLOCK";
  return KIND_TO_ACTIVITY[event.kind];
}
