/**
 * The five `/dashboard/*` responses, copied from the frontend's own module.
 *
 * `frontend/src/lib/dashboard-data.ts` is the specification (D-3), so nothing
 * here is a design: every field name and every unit is read off the type the
 * Control Tower already renders. Money is integer paise, rates are fractions,
 * and `upliftPoints` is the one exception the contract itself declares — it is
 * percentage points, because that is how the strip prints it.
 */

export type Tone = "recovered" | "waiting" | "halted" | "diagnosis" | "neutral";

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

export type FunnelStage = {
  key: string;
  label: string;
  cases: number;
  amountPaise: number;
  tone: Tone;
  href: string;
};

export type RootCauseRow = {
  code: string;
  label: string;
  cases: number;
  recoveredPaise: number;
  openPaise: number;
  method: "RULES" | "LLM";
};

export type SuccessRateSeries = {
  points: { t: string; rate: number }[];
  /**
   * Null when the z-score monitor has not tripped.
   *
   * The frontend's seeded version could not be null, because a fixture always
   * has an incident in it. A live merchant with a healthy gateway does not, and
   * the honest answer is an empty annotation rather than a synthetic
   * "degradation detected" pointing at the day's lowest bucket (D-104).
   */
  incident: { index: number; at: string; casesOpened: number; recoveredAt: string } | null;
  baseline: number;
  current: number;
};

export type ShellStatus = {
  recoveredTodayPaise: number;
  activeCases: number;
  onDuty: boolean;
  policyVersion: string;
  seed: number;
  playbooks: number;
};
