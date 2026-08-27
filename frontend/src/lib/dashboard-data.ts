/**
 * The Control Tower's data (PRD 6.3, page 2).
 *
 * Every function below is now one call to the `/dashboard/*` endpoints it was
 * always shaped like. The seeded figures that used to live here are gone: they
 * were consistent with each other by hand, and they are consistent with each
 * other by construction now, because all of them are aggregates over the same
 * `cases` table.
 *
 * Two things that used to be here are gone entirely rather than rewritten.
 * `getActivityScript` replayed a fixed list so the log breathed during a demo;
 * the log now subscribes to `activity.new` and shows what actually happened.
 * `CLOCK_ANCHOR` timestamps went with it — a live feed is stamped by the writer
 * in IST, not measured against a fixed batch anchor.
 *
 * Amounts are integer paise throughout, matching `cases.amountPaise`; nothing
 * in the UI ever does arithmetic on a formatted string.
 */

import { CASE_TYPE_META, STAGE_META, type PipelineCase } from "./pipeline-data";

/**
 * Five tones, each carrying a meaning. There is no sixth for decoration:
 * a promise and an escalation are both "in flight, needs watching", so both
 * are amber rather than each earning a colour of its own.
 */
export type Tone = "recovered" | "waiting" | "halted" | "diagnosis" | "neutral";

export const TONE_HEX: Record<Tone, string> = {
  recovered: "#34c77b",
  waiting: "#f5b52e",
  halted: "#e5484d",
  diagnosis: "#4a87c7",
  neutral: "#8994a5",
};

/* ------------------------------------------------------------------ */
/* GET /dashboard/kpis                                                 */
/* ------------------------------------------------------------------ */

export type Kpis = {
  revenueAtRiskPaise: number;
  revenueAtRiskCases: number;
  recoveredPaise: number;
  recoveredCases: number;
  recoveryRate: number;
  baselineRate: number;
  upliftPoints: number;
  recoveryRateSeries: number[];
  activeCases: number;
  activeBreakdown: { label: string; count: number; tone: Tone }[];
  costPer100Paise: number;
  llmSharePercent: number;
};

/* ------------------------------------------------------------------ */
/* GET /dashboard/funnel                                               */
/* ------------------------------------------------------------------ */

export type FunnelStage = {
  key: string;
  label: string;
  cases: number;
  amountPaise: number;
  tone: Tone;
  /** Pipeline, pre-filtered to this stage. */
  href: string;
};

/* ------------------------------------------------------------------ */
/* GET /dashboard/root-causes                                          */
/* ------------------------------------------------------------------ */

export type RootCauseRow = {
  code: string;
  label: string;
  cases: number;
  recoveredPaise: number;
  openPaise: number;
  method: "RULES" | "LLM";
};

/* ------------------------------------------------------------------ */
/* GET /dashboard/success-rate-series                                  */
/* ------------------------------------------------------------------ */

export type SuccessRateSeries = {
  /** Success rate per 30-minute bucket, 00:00 to 23:30 IST. */
  points: { t: string; rate: number }[];
  /**
   * Where the z-score monitor tripped (PRD 7.7), or null.
   *
   * Nullable now, and that is a contract change with a reason. The seeded
   * version could not be null because a fixture always has its incident in it;
   * a live merchant with a healthy gateway does not, and the honest answer is
   * an empty annotation rather than a synthetic "degradation detected" pointing
   * at the day's lowest bucket (D-104).
   */
  incident: { index: number; at: string; casesOpened: number; recoveredAt: string } | null;
  baseline: number;
  current: number;
};

/* ------------------------------------------------------------------ */
/* The working list                                                    */
/* ------------------------------------------------------------------ */

export type CaseRow = {
  id: string;
  type: "Payment" | "Checkout" | "Mandate" | "Invoice";
  customer: string;
  contact: string;
  amountPaise: number;
  rootCause: string;
  confidence: number;
  method: "RULES" | "LLM";
  nextAction: string;
  attempts: number;
  attemptCap: number;
  status: string;
  tone: Tone;
  updated: string;
};

/**
 * One pipeline row, relabelled for the Control Tower's table.
 *
 * A pure projection, kept here beside the type rather than in `lib/queries`,
 * because it is presentation: which stage label the row shows, what a null
 * confidence draws as, how an age is worded. The query that feeds it lives with
 * the other reads.
 */
export function toCaseRow(record: PipelineCase): CaseRow {
  const stage = STAGE_META[record.stage];

  return {
    id: record.id,
    type: CASE_TYPE_META[record.type].short as CaseRow["type"],
    customer: record.customer,
    contact: record.contact,
    amountPaise: record.amountPaise,
    rootCause: record.rootCause,
    // The table renders a confidence bar, and a case not yet diagnosed has no
    // reading to draw. Zero says "nothing yet", which is what the null means.
    confidence: record.confidence ?? 0,
    method: record.method ?? "RULES",
    nextAction: record.nextAction,
    attempts: record.attempts,
    attemptCap: record.attemptCap,
    status: stage.label,
    tone: stage.tone,
    updated: relative(record.updatedMinutesAgo),
  };
}

/** Coarse and relative: a wall-clock time here would differ between the server render and the client's. */
function relative(minutes: number): string {
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1_440) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1_440)}d ago`;
}

/* ------------------------------------------------------------------ */
/* GET /dashboard/activity · socket `activity.new`                     */
/* ------------------------------------------------------------------ */

export type ActivityKind =
  | "DETECT"
  | "DIAGNOSE"
  | "POLICY"
  | "POLICY_BLOCK"
  | "MESSAGE"
  | "CALL"
  | "RETRY"
  | "PROMISE"
  | "ESCALATE"
  | "HALT"
  | "RECOVERED";

/** Who acted. An operator scanning the log filters on this first. */
export type ActivityActor = "BOA" | "POLICY" | "RECOVERY";

export type ActivityEntry = {
  id: string;
  kind: ActivityKind;
  actor: ActivityActor;
  /** "—" for events that belong to no single case, such as a degradation. */
  caseId: string;
  /**
   * Where the entry leads, when that is not its case.
   *
   * A degradation is not a case — it is the reason forty-seven of them were
   * opened — and linking it to `/cases/—` produced a real 404 off the busiest
   * surface in the demo. It points at the cases it opened instead.
   */
  href?: string;
  /** One line, what happened. */
  title: string;
  /** One line, the technical detail behind it. */
  meta: string;
  /** HH:MM:SS IST, stamped by the writer so every reader shows the same string. */
  time: string;
};

export const ACTOR_TONE: Record<ActivityActor, Tone> = {
  BOA: "diagnosis",
  POLICY: "waiting",
  RECOVERY: "recovered",
};

/* ------------------------------------------------------------------ */
/* GET /dashboard/shell-status                                         */
/* ------------------------------------------------------------------ */

export type ShellStatus = {
  recoveredTodayPaise: number;
  activeCases: number;
  onDuty: boolean;
  policyVersion: string;
  /** The seed of the batch on screen; 0 when the dataset did not come from a run. */
  seed: number;
  playbooks: number;
};

