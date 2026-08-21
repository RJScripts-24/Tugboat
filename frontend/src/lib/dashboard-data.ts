/**
 * Seeded Control Tower data.
 *
 * Every export here is shaped like the response of the endpoint named beside it
 * (PRD 7.5), so wiring the real NestJS API in later means replacing the body of
 * one function - not touching a single component. Amounts are in paise
 * throughout, matching `cases.amount_paise` in the schema; nothing in the UI
 * ever does arithmetic on a formatted string.
 *
 * The figures are the demo merchant's seeded batch: 214 cases, the same run the
 * pitch narrates. They are consistent with each other on purpose - the funnel,
 * the root-cause split, the case list and the headline recovered figure all add
 * up, because a panelist who adds them up and finds they don't is a panelist
 * you have lost.
 */

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

const RUPEE = 100; // paise per rupee

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

export function getKpis(): Kpis {
  return {
    revenueAtRiskPaise: 412_000 * RUPEE,
    revenueAtRiskCases: 214,
    recoveredPaise: 184_300 * RUPEE,
    recoveredCases: 96,
    recoveryRate: 0.447,
    baselineRate: 0.112,
    upliftPoints: 33.5,
    recoveryRateSeries: [
      28.4, 30.1, 29.6, 33.2, 34.8, 33.9, 37.5, 39.1, 38.4, 41.0, 42.6, 41.8, 43.9, 44.7,
    ],
    activeCases: 63,
    activeBreakdown: [
      { label: "intervening", count: 24, tone: "waiting" },
      { label: "waiting", count: 18, tone: "neutral" },
      { label: "diagnosed", count: 9, tone: "diagnosis" },
      { label: "escalated", count: 7, tone: "waiting" },
      { label: "promised", count: 5, tone: "waiting" },
    ],
    costPer100Paise: 310,
    llmSharePercent: 18,
  };
}

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

export function getFunnel(): FunnelStage[] {
  return [
    {
      key: "detected",
      label: "Detected",
      cases: 214,
      amountPaise: 412_000 * RUPEE,
      tone: "neutral",
      href: "/cases?stage=detected",
    },
    {
      key: "diagnosed",
      label: "Diagnosed",
      cases: 208,
      amountPaise: 401_600 * RUPEE,
      tone: "diagnosis",
      href: "/cases?stage=diagnosed",
    },
    {
      key: "intervening",
      label: "Intervening",
      cases: 141,
      amountPaise: 286_400 * RUPEE,
      tone: "waiting",
      href: "/cases?stage=intervening",
    },
    {
      key: "promised",
      label: "Committed",
      cases: 38,
      amountPaise: 92_700 * RUPEE,
      tone: "waiting",
      href: "/cases?stage=promised",
    },
    {
      key: "recovered",
      label: "Recovered",
      cases: 96,
      amountPaise: 184_300 * RUPEE,
      tone: "recovered",
      href: "/cases?stage=recovered",
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Recovery by root cause                                              */
/* ------------------------------------------------------------------ */

export type RootCauseRow = {
  code: string;
  label: string;
  cases: number;
  recoveredPaise: number;
  openPaise: number;
  method: "RULES" | "LLM";
};

/** Case counts sum to 214 and recovered sums to ₹1,84,300 - deliberately. */
export function getRecoveryByRootCause(): RootCauseRow[] {
  return [
    {
      code: "BANK_GATEWAY_DEGRADED",
      label: "Bank gateway degraded",
      cases: 71,
      recoveredPaise: 68_400 * RUPEE,
      openPaise: 14_200 * RUPEE,
      method: "RULES",
    },
    {
      code: "INSUFFICIENT_FUNDS",
      label: "Insufficient funds",
      cases: 47,
      recoveredPaise: 42_100 * RUPEE,
      openPaise: 38_600 * RUPEE,
      method: "RULES",
    },
    {
      code: "CUSTOMER_DISTRACTED",
      label: "Customer distracted",
      cases: 39,
      recoveredPaise: 31_600 * RUPEE,
      openPaise: 44_800 * RUPEE,
      method: "LLM",
    },
    {
      code: "CARD_EXPIRED",
      label: "Card expired",
      cases: 28,
      recoveredPaise: 28_900 * RUPEE,
      openPaise: 12_400 * RUPEE,
      method: "RULES",
    },
    {
      code: "MANDATE_REVOKED",
      label: "Mandate revoked",
      cases: 19,
      recoveredPaise: 13_300 * RUPEE,
      openPaise: 27_900 * RUPEE,
      method: "RULES",
    },
    {
      code: "UNKNOWN",
      label: "Unknown — escalated",
      cases: 10,
      recoveredPaise: 0,
      openPaise: 8_900 * RUPEE,
      method: "LLM",
    },
  ];
}

/* ------------------------------------------------------------------ */
/* GET /dashboard/success-rate-series                                  */
/* ------------------------------------------------------------------ */

export type SuccessRateSeries = {
  /** Success rate per 30-minute bucket, 00:00 to 23:30 IST. */
  points: { t: string; rate: number }[];
  /** Where the z-score monitor tripped (PRD 7.7). */
  incident: { index: number; at: string; casesOpened: number; recoveredAt: string };
  baseline: number;
  current: number;
};

const RATES = [
  94.2, 93.8, 94.6, 95.1, 94.4, 93.9, 94.8, 95.3, 94.9, 94.1, 93.6, 94.3, 95.0, 95.6, 95.2, 94.7,
  94.0, 93.4, 94.1, 94.9, 95.4, 95.8, 95.1, 94.6, 94.2, 93.7, 94.4, 93.1, 88.6, 61.4, 64.9, 79.2,
  90.3, 93.8, 94.6, 95.2, 94.8, 94.3, 93.9, 94.5, 95.0, 94.6, 94.1, 93.8, 94.4, 95.0, 94.7, 94.2,
];

export function getSuccessRateSeries(): SuccessRateSeries {
  return {
    points: RATES.map((rate, i) => {
      const hour = String(Math.floor(i / 2)).padStart(2, "0");
      const minute = i % 2 === 0 ? "00" : "30";
      return { t: `${hour}:${minute}`, rate };
    }),
    incident: { index: 29, at: "14:32", casesOpened: 47, recoveredAt: "16:04" },
    baseline: 94.5,
    current: RATES[RATES.length - 1],
  };
}

/* ------------------------------------------------------------------ */
/* GET /cases?status=active                                            */
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

/** The working list behind the funnel - what an operator actually scans. */
export function getActiveCases(): CaseRow[] {
  return [
    {
      id: "C-1195",
      type: "Payment",
      customer: "Acme Labs",
      contact: "98•••••210",
      amountPaise: 4_800 * RUPEE,
      rootCause: "CARD_EXPIRED",
      confidence: 0.71,
      method: "LLM",
      nextAction: "WhatsApp · 09:00",
      attempts: 1,
      attemptCap: 4,
      status: "Intervening",
      tone: "waiting",
      updated: "23:30:37",
    },
    {
      id: "C-1187",
      type: "Payment",
      customer: "Nova Foods",
      contact: "97•••••441",
      amountPaise: 2_340 * RUPEE,
      rootCause: "BANK_GATEWAY_DEGRADED",
      confidence: 0.93,
      method: "RULES",
      nextAction: "—",
      attempts: 1,
      attemptCap: 4,
      status: "Recovered",
      tone: "recovered",
      updated: "14:41:12",
    },
    {
      id: "C-1174",
      type: "Checkout",
      customer: "Orbit Retail",
      contact: "90•••••118",
      amountPaise: 8_200 * RUPEE,
      rootCause: "CUSTOMER_DISTRACTED",
      confidence: 0.68,
      method: "LLM",
      nextAction: "Email · tomorrow 10:00",
      attempts: 2,
      attemptCap: 4,
      status: "Waiting",
      tone: "neutral",
      updated: "23:29:04",
    },
    {
      id: "C-1163",
      type: "Invoice",
      customer: "Kettle & Co",
      contact: "ops@•••••.in",
      amountPaise: 26_500 * RUPEE,
      rootCause: "CUSTOMER_DISTRACTED",
      confidence: 0.74,
      method: "LLM",
      nextAction: "Blocked · opt-out",
      attempts: 2,
      attemptCap: 4,
      status: "Halted",
      tone: "halted",
      updated: "14:36:22",
    },
    {
      id: "C-1156",
      type: "Mandate",
      customer: "Sunrise Dairy",
      contact: "96•••••077",
      amountPaise: 1_499 * RUPEE,
      rootCause: "INSUFFICIENT_FUNDS",
      confidence: 0.96,
      method: "RULES",
      nextAction: "Re-present 2/3 · 24 Aug",
      attempts: 1,
      attemptCap: 3,
      status: "Intervening",
      tone: "waiting",
      updated: "23:30:33",
    },
    {
      id: "C-1149",
      type: "Checkout",
      customer: "Beam Interiors",
      contact: "88•••••905",
      amountPaise: 2_400 * RUPEE,
      rootCause: "CUSTOMER_DISTRACTED",
      confidence: 0.62,
      method: "LLM",
      nextAction: "Awaiting approval · 12% discount",
      attempts: 2,
      attemptCap: 4,
      status: "Escalated",
      tone: "waiting",
      updated: "14:34:40",
    },
    {
      id: "C-1102",
      type: "Invoice",
      customer: "Harbour Textiles",
      contact: "93•••••562",
      amountPaise: 18_400 * RUPEE,
      rootCause: "CUSTOMER_DISTRACTED",
      confidence: 0.81,
      method: "LLM",
      nextAction: "Promise check-in · 24 Aug",
      attempts: 3,
      attemptCap: 4,
      status: "Committed",
      tone: "waiting",
      updated: "23:12:48",
    },
    {
      id: "C-1088",
      type: "Mandate",
      customer: "Peak Fitness",
      contact: "99•••••334",
      amountPaise: 999 * RUPEE,
      rootCause: "MANDATE_REVOKED",
      confidence: 0.99,
      method: "RULES",
      nextAction: "—",
      attempts: 3,
      attemptCap: 3,
      status: "Exhausted",
      tone: "neutral",
      updated: "11:07:15",
    },
    {
      id: "C-1071",
      type: "Payment",
      customer: "Lumen Studio",
      contact: "70•••••826",
      amountPaise: 12_050 * RUPEE,
      rootCause: "INSUFFICIENT_FUNDS",
      confidence: 0.91,
      method: "RULES",
      nextAction: "—",
      attempts: 3,
      attemptCap: 4,
      status: "Recovered",
      tone: "recovered",
      updated: "09:52:31",
    },
    {
      id: "C-1064",
      type: "Payment",
      customer: "Tiller Group",
      contact: "81•••••390",
      amountPaise: 7_600 * RUPEE,
      rootCause: "UNKNOWN",
      confidence: 0.41,
      method: "LLM",
      nextAction: "Escalated · confidence < 0.60",
      attempts: 0,
      attemptCap: 4,
      status: "Escalated",
      tone: "waiting",
      updated: "08:44:02",
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Socket.IO `activity.new`                                            */
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
  caseId: string;
  /** One line, what happened. */
  title: string;
  /** One line, the technical detail behind it. */
  meta: string;
  /** Fixed on the seeded entries so server and client render the same string. */
  time: string;
};

export const ACTOR_TONE: Record<ActivityActor, Tone> = {
  BOA: "diagnosis",
  POLICY: "waiting",
  RECOVERY: "recovered",
};

export function getSeedActivity(): ActivityEntry[] {
  return [
    {
      id: "a-08",
      kind: "RECOVERED",
      actor: "RECOVERY",
      caseId: "C-1187",
      title: "₹2,340 recovered",
      meta: "#C-1187 · silent retry · 1 attempt · 41m to recovery",
      time: "14:41:12",
    },
    {
      id: "a-07",
      kind: "RETRY",
      actor: "BOA",
      caseId: "C-1187",
      title: "Retry executed #C-1187",
      meta: "razorpay test mode · pay_S9kQ2fLm · captured",
      time: "14:40:58",
    },
    {
      id: "a-06",
      kind: "POLICY",
      actor: "POLICY",
      caseId: "C-1187",
      title: "Silent retry cleared #C-1187",
      meta: "6/6 checks passed · policy v4 · quiet-hours exempt",
      time: "14:40:51",
    },
    {
      id: "a-05",
      kind: "DIAGNOSE",
      actor: "BOA",
      caseId: "C-1187",
      title: "Diagnosed #C-1187",
      meta: "BANK_GATEWAY_DEGRADED · confidence 0.93 · rules-table",
      time: "14:38:07",
    },
    {
      id: "a-04",
      kind: "HALT",
      actor: "POLICY",
      caseId: "C-1163",
      title: "Halted #C-1163",
      meta: "opt-out keyword · all channels blocked · non-negotiable",
      time: "14:36:22",
    },
    {
      id: "a-03",
      kind: "ESCALATE",
      actor: "BOA",
      caseId: "C-1149",
      title: "Escalated #C-1149",
      meta: "12% discount above 15% cap · awaiting approval",
      time: "14:34:40",
    },
    {
      id: "a-02",
      kind: "DETECT",
      actor: "BOA",
      caseId: "C-1187",
      title: "Case opened #C-1187",
      meta: "UPI payment failed · ₹2,340 at risk · U69/timeout",
      time: "14:32:19",
    },
    {
      id: "a-01",
      kind: "DETECT",
      actor: "BOA",
      caseId: "—",
      title: "Degradation detected",
      meta: "success rate 61.4% vs 94.5% baseline · 47 cases opened",
      time: "14:32:04",
    },
  ];
}

/**
 * The rest of the seeded run, replayed one entry at a time so the log breathes
 * during the demo. This is a stand-in for the `activity.new` socket event: when
 * the gateway exists, the feed subscribes instead of stepping through this list.
 */
export function getActivityScript(): Omit<ActivityEntry, "time">[] {
  return [
    {
      id: "s-01",
      kind: "MESSAGE",
      actor: "BOA",
      caseId: "C-1174",
      title: "WhatsApp nudge sent #C-1174",
      meta: "payment link plink_S3xR8a · attempt 2/4",
    },
    {
      id: "s-02",
      kind: "POLICY_BLOCK",
      actor: "POLICY",
      caseId: "C-1156",
      title: "Deferred #C-1156",
      meta: "quiet hours 21:00–09:00 IST · rescheduled 09:00",
    },
    {
      id: "s-03",
      kind: "DIAGNOSE",
      actor: "BOA",
      caseId: "C-1195",
      title: "Diagnosed #C-1195",
      meta: "CARD_EXPIRED · confidence 0.71 · LLM",
    },
    {
      id: "s-04",
      kind: "CALL",
      actor: "BOA",
      caseId: "C-1102",
      title: "Hinglish voice call #C-1102",
      meta: "1m 12s · intent PROMISED_TO_PAY · simulated telephony",
    },
    {
      id: "s-05",
      kind: "PROMISE",
      actor: "BOA",
      caseId: "C-1102",
      title: "Promise recorded #C-1102",
      meta: "₹18,400 by 24 Aug · follow-up job queued",
    },
    {
      id: "s-06",
      kind: "RECOVERED",
      actor: "RECOVERY",
      caseId: "C-1174",
      title: "₹6,780 recovered",
      meta: "#C-1174 · payment link paid · 2 attempts",
    },
    {
      id: "s-07",
      kind: "DETECT",
      actor: "BOA",
      caseId: "C-1201",
      title: "Case opened #C-1201",
      meta: "e-mandate debit bounced · ₹1,499 at risk",
    },
    {
      id: "s-08",
      kind: "DIAGNOSE",
      actor: "BOA",
      caseId: "C-1201",
      title: "Diagnosed #C-1201",
      meta: "INSUFFICIENT_FUNDS · confidence 0.96 · rules-table",
    },
    {
      id: "s-09",
      kind: "POLICY",
      actor: "POLICY",
      caseId: "C-1201",
      title: "Re-presentation 2/3 scheduled #C-1201",
      meta: "spacing 3 days · RBI e-mandate discipline",
    },
    {
      id: "s-10",
      kind: "MESSAGE",
      actor: "BOA",
      caseId: "C-1201",
      title: "Email sent #C-1201",
      meta: "fund-account notice · resend v2 · attempt 1/4",
    },
    {
      id: "s-11",
      kind: "ESCALATE",
      actor: "BOA",
      caseId: "C-1188",
      title: "Escalated #C-1188",
      meta: "hardship language detected · agent standing down",
    },
    {
      id: "s-12",
      kind: "RECOVERED",
      actor: "RECOVERY",
      caseId: "C-1166",
      title: "₹12,050 recovered",
      meta: "#C-1166 · approved discount · 3 attempts",
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Sidebar counters                                                    */
/* ------------------------------------------------------------------ */

export function getShellStatus() {
  return {
    pendingApprovals: 4,
    recoveredTodayPaise: 47_820 * RUPEE,
    activeCases: 63,
    onDuty: true,
    policyVersion: "v4",
    seed: 42,
    playbooks: 4,
  };
}
