/**
 * Case Detail (PRD 6.3, page 4) — the full replayable story of one case.
 *
 * `GET /cases/:id` returns the case plus its events, its scheduled work, its
 * bounds and its own ledger chain. The timeline renders the event log directly
 * (ADR-2), so there is exactly one account of what happened and no way for
 * "what the agent did" and "what the screen says" to drift apart.
 *
 * This file used to *construct* that story. Every case in the seeded batch
 * resolved here, narrated from the facts the Pipeline published about it, with
 * a seeded PRNG keyed by case id so the same case looked the same on every
 * reload. Eighteen hundred lines of it — and every one of them existed to make
 * a fixture behave like a record. The record is real now: the events were
 * written by the Executor as it worked the case, the policy checks by the gate
 * that ran them, and the audit rows inside the transactions that earned them.
 *
 * What remains here is the vocabulary — the event kinds, the body shapes, the
 * channel metadata — because those are the contract, and both halves of the
 * system are written against them.
 */

import type { Tone } from "./dashboard-data";
import {
  CASE_TYPE_META,
  ROOT_CAUSE_META,
  STAGE_META,
  type CaseType,
  type PipelineCase,
  type RootCause,
  type Stage,
} from "./pipeline-data";

/* ------------------------------------------------------------------ */
/* Vocabulary                                                          */
/* ------------------------------------------------------------------ */
export type Channel = "RETRY" | "WHATSAPP" | "EMAIL" | "VOICE";

export const CHANNEL_META: Record<Channel, { label: string; short: string; mode: string }> = {
  RETRY: { label: "Razorpay retry", short: "Retry", mode: "Razorpay test mode · real endpoint" },
  WHATSAPP: { label: "WhatsApp", short: "WhatsApp", mode: "Twilio sandbox · real message" },
  EMAIL: { label: "Email", short: "Email", mode: "Resend · real message" },
  VOICE: { label: "Voice call", short: "Voice", mode: "Telephony · simulated unless the lane is real, labelled per call" },
};

export type EventKind =
  | "DETECTED"
  | "DIAGNOSED"
  | "PLANNED"
  | "POLICY_CHECK"
  | "EMAIL_SENT"
  | "WHATSAPP_SENT"
  | "VOICE_CALL"
  | "RETRY_EXECUTED"
  | "CUSTOMER_REPLY"
  | "PROMISE_RECORDED"
  | "ESCALATED"
  | "APPROVAL_DECIDED"
  | "HALTED"
  | "RECOVERED";

export type Sentiment = "positive" | "neutral" | "negative" | "opt-out";

export type FactRow = { label: string; value: string; mono?: boolean; tone?: Tone };

export type PolicyCheck = { name: string; verdict: "pass" | "block" | "skip"; note: string };

export type Turn = { speaker: "BOA" | "CUSTOMER"; text: string };

export type EventBody =
  | { type: "facts"; rows: FactRow[] }
  | { type: "diagnosis"; reasoning: string[]; rows: FactRow[] }
  | {
      type: "plan";
      chosen: string;
      because: string;
      rejected: { option: string; reason: string }[];
    }
  | { type: "policy"; checks: PolicyCheck[]; rows: FactRow[] }
  | {
      type: "message";
      channel: "EMAIL" | "WHATSAPP";
      subject?: string;
      lines: string[];
      link?: string;
      rows: FactRow[];
    }
  | {
      type: "voice";
      seconds: number;
      transcript: Turn[];
      summary: string;
      intent: string;
      /** A stitched server-side recording of a simulated call (Stage 10), or a real call's recording (D-144). */
      audioUrl?: string | null;
      /** What the recording is, in the API's words — printed under the player. */
      recording?: string | null;
      rows: FactRow[];
    }
  | { type: "reply"; channel: Channel; text: string; sentiment: Sentiment; rows: FactRow[] }
  | { type: "promise"; amountPaise: number; dateLabel: string; daysAway: number; rows: FactRow[] };

export type CaseEvent = {
  id: string;
  seq: number;
  kind: EventKind;
  /** Minutes before the batch clock anchor. Pending events carry 0. */
  minutesAgo: number;
  title: string;
  summary: string;
  badge?: { label: string; tone: Tone };
  body?: EventBody;
};

export type AuditEntry = {
  seq: number;
  hash: string;
  prevHash: string;
  actor: "BOA" | "POLICY" | "SYSTEM" | "HUMAN";
  action: string;
  minutesAgo: number;
  detail: string;
};

export type CustomerProfile = {
  name: string;
  phone: string;
  email: string;
  language: string;
  languageNote: string;
  timezone: string;
  segment: "B2C" | "B2B";
  history: string;
};

export type OriginObject = {
  kind: string;
  id: string;
  href: string;
  reference: string;
};

export type Bounds = {
  attemptsUsed: number;
  attemptCap: number;
  channels: { channel: Channel; used: number; cap: number }[];
  quietHours: string;
  quietNote: string;
  optedOut: boolean;
  optOutNote: string;
  coolDownMinutesLeft: number | null;
  coolDownNote: string;
  deadlineNote: string;
  policyVersion: string;
  /**
   * The case has stopped. Every other number here still reports what it
   * measured, but none of them will ever be spent - a halted case advertising
   * "2 attempts left" would describe rope the gate has already cut.
   */
  closed: boolean;
  /** What ended it, in the panel's own words. */
  closedNote: string | null;
};

export type Outcome = {
  stage: Stage;
  headline: string;
  detail: string;
  atRiskPaise: number;
  recoveredPaise: number;
  timeToRecoveryMinutes: number | null;
  contacts: number;
  llmCalls: number;
  llmTokens: number;
  /** What the run actually cost on the free tiers - which is nothing. */
  spentPaise: number;
  /** What the same run would cost at production prices (PRD 5.5). */
  projectedLlmPaise: number;
  projectedChannelPaise: number;
};

export type CaseDetail = {
  record: PipelineCase;
  customer: CustomerProfile;
  origin: OriginObject;
  openedMinutesAgo: number;
  deadlineLabel: string;
  bounds: Bounds;
  events: CaseEvent[];
  /** Scheduled, not yet executed - the timeline reveals these live. */
  pending: CaseEvent[];
  outcome: Outcome;
  audit: AuditEntry[];
};

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

/** Whole rupees with Indian grouping. No symbol — callers add it. */
export function inr(paise: number): string {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(
    Math.round(paise / 100),
  );
}

/** Sub-rupee precision, for the cost figures. */
export function paiseText(paise: number): string {
  return `₹${new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(paise / 100)}`;
}

/* ------------------------------------------------------------------ */
/* GET /cases/:id                                                      */
/* ------------------------------------------------------------------ */



export type CaseDetailWithNeighbours = CaseDetail & {
  neighbours: { prev: string | null; next: string | null };
  pausedAt: string | null;
  /** How many cases the batch holds, for the "C-1042 of 214" walk control. */
  batchSize: number;
};

export { CASE_TYPE_META, ROOT_CAUSE_META, STAGE_META };
export type { CaseType, PipelineCase, RootCause, Stage };
