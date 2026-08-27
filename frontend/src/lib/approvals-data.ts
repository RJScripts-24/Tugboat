/**
 * Approvals Queue (PRD 6.3, page 5) — the work the agent is not allowed to do
 * on its own.
 *
 * `GET /approvals` returns the queue, `/history` the decisions already taken
 * and `/stats` the fourteen figures above them. Every one of those is computed
 * from `approvals` rows on the way out, never stored beside them (D-72): a
 * median that is recomputed on every request cannot drift from the table it
 * describes, and a mean would describe nobody.
 *
 * The generators that used to live here are gone. A pending request is now a
 * real `approvals` row composed at the instant the gate refused an action
 * (D-64), which is what makes "nothing was sent" a query rather than a claim —
 * the action it stopped is sitting in `NEEDS_APPROVAL`, and it is still there
 * after a reload.
 *
 * What stays is the vocabulary: the four gates, what each one means, and the
 * rejection reasons each one offers. The API serves the reasons on every
 * request too (D-70), so the dialog's options and the reasons the history table
 * can contain are one list; the copy below is the same list, kept here because
 * the dialog imports it directly.
 */

import type { Tone } from "./dashboard-data";
import {
  CASE_TYPE_META,
  ROOT_CAUSE_META,
  type CaseType,
  type RootCause,
  type Stage,
} from "./pipeline-data";

/* ------------------------------------------------------------------ */
/* Vocabulary                                                          */
/* ------------------------------------------------------------------ */

/**
 * The four gates from PRD 9.6, and the whole reason this page exists: an
 * action that trips one of them is planned, checked and then *stopped* - it
 * never executes and asks forgiveness afterwards.
 */
export type ApprovalGate =
  | "discount_requires_approval"
  | "b2b_high_value"
  | "confidence_below_threshold"
  | "hardship_language";

export const GATE_META: Record<
  ApprovalGate,
  { label: string; rule: string; tone: Tone }
> = {
  discount_requires_approval: {
    label: "Discount",
    rule: "Any discount needs a human — there is no threshold under which Boa may give money away",
    tone: "waiting",
  },
  b2b_high_value: {
    label: "High-value B2B",
    rule: "Receivables over ₹25,000 are worked by a person, not by an agent",
    tone: "waiting",
  },
  confidence_below_threshold: {
    label: "Low confidence",
    rule: "Under 0.60 the diagnosis is not trusted, so Boa escalates instead of guessing",
    tone: "diagnosis",
  },
  hardship_language: {
    label: "Hardship",
    rule: "Dispute or hardship language stops the agent immediately and hands the case over",
    tone: "halted",
  },
};

export type PolicyChip = { label: string; tone?: Tone };

export type DraftChannel = "WHATSAPP" | "EMAIL" | "VOICE" | "RETRY";

/**
 * The exact thing that would leave the building.
 *
 * Not a summary of it - a summary is what an approver skims and then owns
 * without having read. This is the body, the recipient and the link, and it is
 * editable before it is approved.
 */
export type DraftMessage = {
  channel: DraftChannel;
  to: string;
  subject?: string;
  lines: string[];
  link?: string;
  /** What executing it actually does, in one line. */
  note: string;
};

/** What the case gains the moment a human says yes. */
export type ResumeStep = { label: string; detail: string };

export type ApprovalRequest = {
  id: string;
  caseId: string;
  gate: ApprovalGate;
  customer: string;
  segment: "B2C" | "B2B";
  caseType: CaseType;
  rootCause: RootCause;
  confidence: number | null;
  atRiskPaise: number;
  /** What approving costs the merchant. Zero unless the ask is a concession. */
  concessionPaise: number;
  /** One line: the action, what it costs, and the money it is chasing. */
  headline: string;
  /** Boa's case for it, in two lines, from the planner's LLM. */
  justification: string[];
  chips: PolicyChip[];
  draft: DraftMessage;
  /** Where the diagnosis got to - only when the gate is confidence. */
  candidates: { label: string; probability: number }[];
  attempts: number;
  attemptCap: number;
  contact: string;
  requestedMinutesAgo: number;
  ifApproved: string;
  ifRejected: string;
  resumeSteps: ResumeStep[];
};

/* ------------------------------------------------------------------ */
/* Decisions already taken                                             */
/* ------------------------------------------------------------------ */

export type DecidedApproval = {
  id: string;
  caseId: string;
  gate: ApprovalGate;
  decision: "approved" | "rejected";
  decidedBy: string;
  /** The attempt the case was on when the gate stopped it. */
  afterAttempt: number;
  headline: string;
  /** Rejections carry one; an approval does not need one. */
  reason: string | null;
  requestedMinutesAgo: number;
  decidedMinutesAgo: number;
  latencySeconds: number;
};

export type ApprovalHistoryRow = DecidedApproval & {
  customer: string;
  caseType: CaseType;
  stage: Stage;
  atRiskPaise: number;
  recoveredPaise: number;
  concessionPaise: number;
  /** What happened to the money afterwards, in the case's own figures. */
  outcome: string;
};


/* ------------------------------------------------------------------ */
/* Statistics                                                          */
/* ------------------------------------------------------------------ */

export type ApprovalStats = {
  pending: number;
  pendingValuePaise: number;
  oldestWaitMinutes: number;
  decisions: number;
  approved: number;
  rejected: number;
  approvalRate: number;
  medianLatencySeconds: number;
  slowestLatencySeconds: number;
  releasedValuePaise: number;
  recoveredAfterApprovalPaise: number;
  recoveredAfterApprovalCases: number;
  /** Of the value a yes released, how much actually came back. */
  postApprovalRecoveryRate: number;
  concessionPaise: number;
};


/* ------------------------------------------------------------------ */
/* Rejection reasons                                                   */
/* ------------------------------------------------------------------ */

/**
 * Three or four per gate, never a free-text box.
 *
 * A reason has to be answerable by the person the gate is asking, and a list
 * they can pick from is a list they will actually use — a text field on a queue
 * somebody clears in the morning ends up holding "no" fourteen times. The API
 * serves the same list on every request; this copy exists so the dialog can
 * render before one arrives.
 */
const REJECTION_REASONS: Record<ApprovalGate, string[]> = {
  discount_requires_approval: [
    "Margin is already thin on this line — no discount",
    "This account took a concession last quarter",
    "The amount does not justify giving anything away",
    "Chase it once more, but without a discount",
  ],
  b2b_high_value: [
    "Sales owns this account — they will handle it",
    "Payment is already scheduled · do not chase",
    "This one goes out from our inbox, not the agent's",
  ],
  confidence_below_threshold: [
    "Route to manual review rather than another automated attempt",
    "The guess is wrong — this is not what failed",
    "Too small to spend another attempt on",
  ],
  hardship_language: [
    "No payment plan on this account — close it instead",
    "Collections will take this one from here",
    "The terms are wrong · I will make the offer myself",
  ],
};

/** The reasons the reject dialog offers for a given gate. */
export function rejectionReasonsFor(gate: ApprovalGate): string[] {
  return REJECTION_REASONS[gate];
}

export { CASE_TYPE_META, ROOT_CAUSE_META };
