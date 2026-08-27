/**
 * The Simulation Lab (PRD 6.3, page 6) - the evidence page.
 *
 * `POST /simulations` starts a batch, `GET /simulations/:id/report` returns the
 * artifact it left behind, and `GET /simulations` lists the runs before it.
 * Every figure the page draws comes out of that one report object, which is the
 * same object `docs/evidence/` ships as a file - so the screen and the download
 * are one thing rather than two renderings that have to be kept in step.
 *
 * This file used to compute the report. It read the seeded pipeline and derived
 * the arms, the grading, the firing counts and the exceptions from it, with the
 * two counterfactual arms authored against stated assumptions. That was honest
 * about what it was, and it is not what this page claims any more: the report is
 * a measurement of a batch that really ran, graded against ground truth the
 * agent could not reach (ADR-10), with the compliance block computed from the
 * ledger rows the agent wrote while acting rather than from its own account of
 * itself.
 *
 * `getRunScript` is gone with it. The runner narrates itself over the
 * `sim:<runId>` socket room now, and the counters beside the bar are what the
 * batch has actually done rather than a fraction of a total decided in advance.
 */

import {
  CASE_TYPE_META,
  ROOT_CAUSE_META,
  type CaseType,
  type RootCause,
} from "./pipeline-data";

/** The three presets the Run panel offers. */
export type DifficultyKey = "easy" | "realistic" | "hostile";

export const DIFFICULTY: Record<
  DifficultyKey,
  { label: string; caption: string; responseRate: number; optOutRate: number; silentTail: number }
> = {
  easy: {
    label: "Easy",
    caption: "62% answer on some channel · 1% opt out · no silent tail",
    responseRate: 0.62,
    optOutRate: 0.01,
    silentTail: 0,
  },
  realistic: {
    label: "Realistic",
    caption: "38% answer · 2.8% opt out · 13% never respond on any channel",
    responseRate: 0.38,
    optOutRate: 0.028,
    silentTail: 0.13,
  },
  hostile: {
    label: "Hostile",
    caption: "19% answer · 6% opt out · 28% never respond · deadlines halved",
    responseRate: 0.19,
    optOutRate: 0.06,
    silentTail: 0.28,
  },
};

export const DIFFICULTY_ORDER: DifficultyKey[] = ["easy", "realistic", "hostile"];

export type ArmKey = "baseline" | "naive" | "tugboat";

export const ARM_META: Record<
  ArmKey,
  { label: string; short: string; caption: string; locked?: boolean }
> = {
  baseline: {
    label: "Agent OFF — baseline",
    short: "Baseline",
    caption:
      "Nothing is detected and nobody is contacted. Only the customers who would have come back on their own.",
  },
  naive: {
    label: "Naive — retry everything",
    short: "Naive",
    caption:
      "Every case chased on every channel, immediately, with no diagnosis, no caps and no quiet hours.",
  },
  tugboat: {
    label: "TUGBOAT — full policy v4",
    short: "TUGBOAT",
    caption:
      "Diagnose first, cheapest intervention that fits the cause, every action through the gate.",
    // The arm under test. A report without it is not a report.
    locked: true,
  },
};

export const ARM_ORDER: ArmKey[] = ["baseline", "naive", "tugboat"];

/** The batch sizes the runner offers. 214 is the seeded batch this build ships. */
export const BATCH_SIZES = [100, 214, 500];

export type SimulationConfig = {
  batchSize: number;
  /** Percentage points per case type, summing to 100. */
  mix: Record<CaseType, number>;
  difficulty: DifficultyKey;
  seed: number;
  arms: ArmKey[];
};


/* ------------------------------------------------------------------ */
/* The report                                                          */
/* ------------------------------------------------------------------ */

export type ArmResult = {
  key: ArmKey;
  recoveredPaise: number;
  recoveredCases: number;
  /** Of the money at risk, not of the case count - the funnel is by value. */
  recoveryRate: number;
  contacts: number;
  /** Simulated: a persona contacted past its own tolerance. */
  complaints: number;
  optOuts: number;
  quietHourSends: number;
  costPaise: number;
  /** Paise spent per ₹100 recovered. Null when nothing was spent. */
  costPer100Paise: number | null;
};


export type Headline = {
  atRiskPaise: number;
  cases: number;
  recoveredPaise: number;
  recoveredCases: number;
  recoveryRate: number;
  baselineRate: number;
  upliftPoints: number;
  /** What the uplift is worth, which is the number a merchant actually cares about. */
  upliftPaise: number;
};


export type TypeResult = {
  type: CaseType;
  cases: number;
  atRiskPaise: number;
  recoveredPaise: number;
  recoveredCases: number;
  rate: number;
};


export type Grading = {
  total: number;
  /** Never reached the diagnoser before the batch closed. */
  undiagnosed: number;
  /** Diagnosed, but under the confidence floor - escalated rather than guessed. */
  abstained: number;
  graded: number;
  correct: number;
  wrong: number;
  accuracy: number;
  byMethod: { method: "RULES" | "LLM"; graded: number; correct: number; accuracy: number }[];
  confusions: { truth: RootCause; called: RootCause; count: number }[];
};


export type RuleFiring = {
  key: string;
  rule: string;
  /** What happened to the case when it fired. */
  effect: string;
  fired: number;
  /** Terminal rules close a case; the rest only move it. */
  terminal: boolean;
  /** Cannot be switched off in the Policies UI (PRD 9.4). */
  locked?: boolean;
  /** Counted from the batch rather than authored. */
  derived: boolean;
};


export type ComplianceAssertion = {
  claim: string;
  detail: string;
  /** False would be a finding, not a bug in the report. */
  held: boolean;
};


export type ComplianceBlock = {
  entries: number;
  verified: boolean;
  assertions: ComplianceAssertion[];
};

export type EscalationSummary = {
  total: number;
  pending: number;
  decided: number;
  approved: number;
  rejected: number;
  medianLatencySeconds: number;
  releasedValuePaise: number;
  recoveredAfterApprovalPaise: number;
  postApprovalRecoveryRate: number;
};

export type ExceptionGroup = {
  key: string;
  reason: string;
  /** Why it is the honest outcome rather than a defect. */
  note: string;
  cases: number;
  atRiskPaise: number;
  /** The largest few, by money, so the worst of it is what you see. */
  sample: { id: string; type: CaseType; amountPaise: number; cause: RootCause }[];
};


export type RunMeta = {
  id: string;
  seed: number;
  batchSize: number;
  mix: Record<string, number>;
  difficulty: DifficultyKey;
  difficultyAssumptions: (typeof DIFFICULTY)[DifficultyKey];
  arms: ArmKey[];
  /**
   * The one arm that was executed; the others are counterfactuals.
   *
   * Stated in the artifact rather than left to be assumed, because a reader
   * comparing three columns is entitled to know that two of them were computed
   * rather than run.
   */
  armsExecuted: ArmKey[];
  policyVersion: string;
  codeVersion: string;
  horizonDays: number;
  /** Cases that threw while the batch worked them. Reported, not rounded off. */
  caseErrors: number;
};

/** Exactly the JSON `GET /simulations/:id/report` returns, and the file it downloads as. */
export type EvidenceReport = {
  schema: "tugboat.simulation.report/1";
  run: RunMeta;
  headline: Headline;
  arms: ArmResult[];
  byCaseType: TypeResult[];
  diagnosis: Grading;
  stoppingRules: RuleFiring[];
  compliance: ComplianceBlock;
  escalations: EscalationSummary;
  exceptions: ExceptionGroup[];
  cost: {
    channelPaise: number;
    llmPaise: number;
    /** What the same batch would cost at paid provider rates, not free tiers. */
    projectedPaise: number;
    llmCalls: number;
    tokens: number;
  };
};

/* ------------------------------------------------------------------ */
/* Progress                                                            */
/* ------------------------------------------------------------------ */

export type RunStep = {
  /** Fraction of the batch processed when this line lands. */
  at: number;
  actor: "BOA" | "POLICY" | "RECOVERY";
  line: string;
  meta: string;
};


export type RunStatus = {
  id: string;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";
  progress: number;
  seed: number;
  batchSize: number;
  difficulty: DifficultyKey;
  arms: ArmKey[];
  steps: RunStep[];
  startedAt: string | null;
  finishedAt: string | null;
  failureReason: string | null;
  /** True for the run the Control Tower is currently narrating. */
  current: boolean;
};

/* ------------------------------------------------------------------ */
/* Run history                                                         */
/* ------------------------------------------------------------------ */

export type SavedRun = {
  id: string;
  seed: number;
  batchSize: number;
  difficulty: DifficultyKey;
  policyVersion: string;
  recoveredPaise: number;
  recoveryRate: number;
  baselineRate: number;
  accuracy: number;
  costPer100Paise: number;
  ranMinutesAgo: number;
  /** QUEUED, RUNNING, COMPLETED or FAILED — a failed run keeps its row. */
  status: string;
  /** The run the Control Tower is currently narrating. */
  current?: boolean;
};

/* ------------------------------------------------------------------ */
/* GET /simulations/headline (public)                                  */
/* ------------------------------------------------------------------ */

/**
 * The four figures the landing page prints above the fold.
 *
 * `runId` and `seed` are nullable rather than zeroed, so a page rendered before
 * any batch has been promoted reads as dashes instead of as a plausible
 * measurement of nothing.
 */
export type PublicHeadline = {
  runId: string | null;
  seed: number | null;
  recoveryRate: number;
  upliftPoints: number;
  accuracy: number;
  atRiskPaise: number;
  cases: number;
};

export { CASE_TYPE_META, ROOT_CAUSE_META };
