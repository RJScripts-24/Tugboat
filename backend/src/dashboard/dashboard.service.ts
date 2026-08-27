import { Injectable } from "@nestjs/common";
import type { CaseStage, EventKind, RootCause } from "@prisma/client";

import type { ActivityEntry } from "../common/domain-event";

import { toActivityEntry } from "../cases/case-activity";
import { narratedCases } from "../cases/narrated";
import { ClockService } from "../common/clock.service";
import { PolicyService } from "../policy/policy.service";
import { PrismaService } from "../prisma/prisma.service";
import type {
  FunnelStage,
  Kpis,
  RootCauseRow,
  ShellStatus,
  SuccessRateSeries,
  Tone,
} from "./dashboard.types";

/**
 * Every figure the Control Tower's first screen shows, computed from rows.
 *
 * Nothing on this page is stored. There is no `kpis` table, no counter
 * incremented beside the thing it counts, and no cached headline — every
 * response below is an aggregate over `cases`, `case_events`, `llm_calls` and
 * `payment_samples` at the moment it is asked for. That is the same rule the
 * approvals stats endpoint follows and for the same reason (D-72): a stored KPI
 * drifts from the data underneath it silently, and the first person to notice
 * is a panelist adding the funnel up.
 *
 * The one number that is read rather than derived is the baseline recovery
 * rate. It is a counterfactual — what this batch would have recovered with the
 * agent switched off — and a counterfactual cannot be measured from rows the
 * agent wrote. It comes from the promoted simulation run's own report, where it
 * was computed against the same seeded population, and is zero with no
 * promoted run rather than guessed (D-103).
 */

/** The stages that mean "Boa is still working this", in the order the strip lists them. */
const ACTIVE_STAGES: { stage: CaseStage; tone: Tone }[] = [
  { stage: "intervening", tone: "waiting" },
  { stage: "waiting", tone: "neutral" },
  { stage: "diagnosed", tone: "diagnosis" },
  { stage: "escalated", tone: "waiting" },
  { stage: "promised", tone: "waiting" },
  { stage: "detected", tone: "neutral" },
];

const ROOT_CAUSE_LABELS: Record<RootCause, string> = {
  BANK_GATEWAY_DEGRADED: "Bank gateway degraded",
  INSUFFICIENT_FUNDS: "Insufficient funds",
  CUSTOMER_DISTRACTED: "Customer distracted",
  CARD_EXPIRED: "Card expired",
  MANDATE_REVOKED: "Mandate revoked",
  UNKNOWN: "Unknown — escalated",
};

/** One playbook per `CaseType` (PRD 7.6). */
const PLAYBOOK_COUNT = 4;

/** How many points the KPI sparkline draws. */
const SPARKLINE_POINTS = 14;

/** 30-minute buckets, 00:00 to 23:30 IST — the x-axis the chart already labels. */
const DAY_BUCKETS = 48;
const BUCKET_MINUTES = 30;
const IST_OFFSET_MS = 5.5 * 60 * 60_000;

/** A bucket with no traffic, before it is resolved against the day's baseline. */
const NO_TRAFFIC = -1;

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PolicyService,
    private readonly clock: ClockService,
  ) {}

  async kpis(merchantId: string): Promise<Kpis> {
    const [totals, recoveredCases, byStage, llm, promoted] = await Promise.all([
      this.prisma.case.aggregate({
        where: narratedCases(merchantId),
        _sum: { amountPaise: true, recoveredAmountPaise: true, costPaise: true },
        _count: { _all: true },
      }),
      this.prisma.case.count({ where: { ...narratedCases(merchantId), stage: "recovered" } }),
      this.prisma.case.groupBy({
        by: ["stage"],
        where: narratedCases(merchantId),
        _count: { _all: true },
      }),
      this.prisma.llmCall.aggregate({
        where: { case: narratedCases(merchantId) },
        _sum: { costPaise: true, projectedCostPaise: true },
      }),
      this.promotedHeadline(merchantId),
    ]);

    const atRiskPaise = totals._sum.amountPaise ?? 0;
    const recoveredPaise = totals._sum.recoveredAmountPaise ?? 0;
    const recoveryRate = atRiskPaise === 0 ? 0 : recoveredPaise / atRiskPaise;
    const baselineRate = promoted?.baselineRate ?? 0;

    const counts = new Map(byStage.map((row) => [row.stage, row._count._all]));
    const activeBreakdown = ACTIVE_STAGES.map(({ stage, tone }) => ({
      label: stage,
      count: counts.get(stage) ?? 0,
      tone,
    })).filter((row) => row.count > 0);

    // Channel spend lives on the case; inference spend lives on the call. Both
    // are metered where they are incurred (ADR-11), so the split below is two
    // sums rather than an apportionment of one.
    const channelPaise = totals._sum.costPaise ?? 0;
    // Projected rather than actual: the free tiers bill nothing, and a cost
    // figure reporting ₹0 for inference would flatter the architecture instead
    // of describing it.
    const inferencePaise = llm._sum.projectedCostPaise ?? 0;
    const spentPaise = channelPaise + inferencePaise;

    return {
      revenueAtRiskPaise: atRiskPaise,
      revenueAtRiskCases: totals._count._all,
      recoveredPaise,
      recoveredCases,
      recoveryRate,
      baselineRate,
      // Percentage points, as the contract's own field name says.
      upliftPoints: round1((recoveryRate - baselineRate) * 100),
      recoveryRateSeries: await this.recoveryCurve(merchantId, atRiskPaise),
      activeCases: activeBreakdown.reduce((sum, row) => sum + row.count, 0),
      activeBreakdown,
      costPer100Paise:
        recoveredPaise === 0 ? 0 : Math.round((spentPaise / recoveredPaise) * 10_000),
      llmSharePercent: spentPaise === 0 ? 0 : Math.round((inferencePaise / spentPaise) * 100),
    };
  }

  /**
   * The funnel, counted from the event log rather than from `cases.stage`.
   *
   * A stage column says where a case is now; a funnel is about where cases have
   * *been*. Counting the column would report six cases as "diagnosed" — the six
   * still sitting there — and hide the two hundred that passed through, which
   * makes the widest band of the funnel narrower than every band after it.
   */
  async funnel(merchantId: string): Promise<FunnelStage[]> {
    const stages: { key: string; label: string; tone: Tone; kinds: EventKind[] }[] = [
      { key: "detected", label: "Detected", tone: "neutral", kinds: ["DETECTED"] },
      { key: "diagnosed", label: "Diagnosed", tone: "diagnosis", kinds: ["DIAGNOSED"] },
      {
        key: "intervening",
        label: "Intervening",
        tone: "waiting",
        kinds: ["EMAIL_SENT", "WHATSAPP_SENT", "VOICE_CALL", "RETRY_EXECUTED"],
      },
      { key: "promised", label: "Committed", tone: "waiting", kinds: ["PROMISE_RECORDED"] },
      { key: "recovered", label: "Recovered", tone: "recovered", kinds: ["RECOVERED"] },
    ];

    return Promise.all(
      stages.map(async (stage) => {
        const reached = await this.prisma.case.findMany({
          where: { ...narratedCases(merchantId), events: { some: { kind: { in: stage.kinds } } } },
          select: { amountPaise: true },
        });

        return {
          key: stage.key,
          label: stage.label,
          cases: reached.length,
          amountPaise: reached.reduce((sum, row) => sum + row.amountPaise, 0),
          tone: stage.tone,
          href: `/cases?stage=${stage.key}`,
        };
      }),
    );
  }

  /**
   * Recovery by root cause, with the method that produced the diagnosis.
   *
   * `method` is the majority verdict for the cause rather than a property of
   * it, because both paths can reach the same answer: the rules table names
   * `CARD_EXPIRED` from a gateway code, and the model reaches it from a
   * customer saying their card is new. The badge describes how this batch
   * actually got there.
   */
  async rootCauses(merchantId: string): Promise<RootCauseRow[]> {
    const rows = await this.prisma.case.groupBy({
      by: ["rootCause", "diagnosisMethod"],
      where: narratedCases(merchantId),
      _count: { _all: true },
      _sum: { amountPaise: true, recoveredAmountPaise: true },
    });

    const merged = new Map<
      RootCause,
      { cases: number; recovered: number; atRisk: number; rules: number; llm: number }
    >();

    for (const row of rows) {
      const cause = row.rootCause ?? "UNKNOWN";
      const entry = merged.get(cause) ?? { cases: 0, recovered: 0, atRisk: 0, rules: 0, llm: 0 };

      entry.cases += row._count._all;
      entry.recovered += row._sum.recoveredAmountPaise ?? 0;
      entry.atRisk += row._sum.amountPaise ?? 0;
      if (row.diagnosisMethod === "LLM") entry.llm += row._count._all;
      else entry.rules += row._count._all;

      merged.set(cause, entry);
    }

    return [...merged.entries()]
      .map(([code, entry]) => ({
        code,
        label: ROOT_CAUSE_LABELS[code],
        cases: entry.cases,
        recoveredPaise: entry.recovered,
        // What is still out there: at risk minus what came back, never below
        // zero. A recovery larger than the amount at risk would be a bug
        // upstream, and a negative row here would hide it.
        openPaise: Math.max(0, entry.atRisk - entry.recovered),
        method: entry.llm > entry.rules ? ("LLM" as const) : ("RULES" as const),
      }))
      .sort((a, b) => b.cases - a.cases);
  }

  /**
   * Gateway health over the most recent day that has samples.
   *
   * Read from `payment_samples`, the same table the degradation monitor's
   * z-score runs against (D-32) — so the dip a merchant sees on this chart and
   * the incident the Detector opened are one event seen twice rather than two
   * independent stories that have to be kept in agreement.
   */
  async successRateSeries(merchantId: string): Promise<SuccessRateSeries> {
    // Samples carry the run that recorded them, so the same scope as the cases:
    // live traffic plus the promoted batch. A sample has no relation to walk,
    // hence the id rather than the relation filter the case queries use.
    const promoted = await this.promotedRun(merchantId);
    const narratedSamples = {
      merchantId,
      OR: [{ simRunId: null }, ...(promoted ? [{ simRunId: promoted.id }] : [])],
    };

    const latest = await this.prisma.paymentSample.findFirst({
      where: narratedSamples,
      orderBy: { at: "desc" },
      select: { at: true },
    });

    const dayStart = istDayStart(latest?.at ?? this.clock.now());

    const samples = await this.prisma.paymentSample.findMany({
      where: {
        ...narratedSamples,
        at: { gte: dayStart, lt: new Date(dayStart.getTime() + 86_400_000) },
      },
      select: { at: true, success: true },
    });

    const buckets = Array.from({ length: DAY_BUCKETS }, () => ({ total: 0, ok: 0 }));
    for (const sample of samples) {
      const index = bucketIndex(sample.at, dayStart);
      if (index < 0 || index >= DAY_BUCKETS) continue;
      buckets[index].total += 1;
      if (sample.success) buckets[index].ok += 1;
    }

    const rates = buckets.map((bucket) =>
      bucket.total === 0 ? NO_TRAFFIC : round1((bucket.ok / bucket.total) * 100),
    );

    // An empty bucket is not a 0% success rate — it is no traffic. Carrying the
    // previous reading is what the chart's line already implies between two
    // points; drawing a cliff to zero would read as an outage nobody had.
    carryForward(rates);

    const observed = rates.filter((rate) => rate >= 0);
    const baseline =
      observed.length === 0 ? 0 : round1(observed.reduce((sum, rate) => sum + rate, 0) / observed.length);

    // An incident is narrated if the cases it opened are, or if it opened none
    // yet — a monitor that just tripped on live traffic has no cases to show.
    const incidentRow = await this.prisma.degradationIncident.findFirst({
      where: {
        merchantId,
        detectedAt: { gte: dayStart },
        OR: [{ cases: { some: narratedCases(merchantId) } }, { cases: { none: {} } }],
      },
      orderBy: { detectedAt: "desc" },
    });

    return {
      points: rates.map((rate, index) => ({
        t: bucketLabel(index),
        rate: rate < 0 ? baseline : rate,
      })),
      incident: incidentRow
        ? {
            index: clamp(bucketIndex(incidentRow.detectedAt, dayStart), 0, DAY_BUCKETS - 1),
            at: istClockLabel(incidentRow.detectedAt),
            casesOpened: incidentRow.casesOpened,
            recoveredAt: incidentRow.recoveredAt
              ? istClockLabel(incidentRow.recoveredAt)
              : "still open",
          }
        : null,
      baseline,
      current: observed.length === 0 ? 0 : observed[observed.length - 1],
    };
  }

  /**
   * The last few things Boa did, for the feed to open on.
   *
   * A socket only carries what happens after it connects, so a browser that
   * subscribed and nothing else would show an empty log until the next event —
   * which on a quiet merchant is a page that looks broken. These are the same
   * rows the socket will deliver, read through the same mapper, so the line
   * that arrives live and the line that was already there are indistinguishable
   * (D-110).
   */
  async activity(merchantId: string, limit = 40): Promise<ActivityEntry[]> {
    const events = await this.prisma.caseEvent.findMany({
      where: { case: narratedCases(merchantId) },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: Math.min(limit, 100),
      select: {
        id: true,
        kind: true,
        title: true,
        summary: true,
        badgeLabel: true,
        occurredAt: true,
        caseId: true,
      },
    });

    return events.map((event) => toActivityEntry(event, event.caseId));
  }

  async shellStatus(merchantId: string): Promise<ShellStatus> {
    const since = new Date(this.clock.nowMs() - 86_400_000);

    const [today, active, policy, run] = await Promise.all([
      this.prisma.case.aggregate({
        where: { ...narratedCases(merchantId), stage: "recovered", updatedAt: { gte: since } },
        _sum: { recoveredAmountPaise: true },
      }),
      this.prisma.case.count({
        where: {
          ...narratedCases(merchantId),
          stage: { in: ACTIVE_STAGES.map((row) => row.stage) },
        },
      }),
      this.policy.getActive(merchantId),
      this.promotedRun(merchantId),
    ]);

    return {
      recoveredTodayPaise: today._sum.recoveredAmountPaise ?? 0,
      activeCases: active,
      onDuty: true,
      policyVersion: policy.version,
      // The seed of the batch on screen. Zero says "this dataset did not come
      // from a run", which is the honest answer for a hand-seeded database.
      seed: run?.seed ?? 0,
      playbooks: PLAYBOOK_COUNT,
    };
  }

  /* ---------------------------------------------------------------- */

  /** The one run the Control Tower narrates, or null when nothing has been promoted (D-94). */
  private promotedRun(merchantId: string) {
    return this.prisma.simRun.findFirst({
      where: { merchantId, promotedAt: { not: null } },
      select: { id: true, seed: true, headline: true },
    });
  }

  /** The promoted run's headline, which is where the counterfactual baseline lives. */
  private async promotedHeadline(merchantId: string): Promise<{ baselineRate: number } | null> {
    const run = await this.promotedRun(merchantId);

    const headline = run?.headline as { baselineRate?: unknown } | null | undefined;
    return typeof headline?.baselineRate === "number"
      ? { baselineRate: headline.baselineRate }
      : null;
  }

  /**
   * The sparkline: cumulative recovery rate as the batch worked through.
   *
   * Each point answers "of all the money at risk, how much had come back by
   * here" — a curve that can only rise, which is what a recovery rate is.
   * Stepped through the recoveries in time order rather than bucketed by
   * wall-clock hour, so a batch that ran in fifteen minutes and one that ran
   * over three days draw the same shape.
   */
  private async recoveryCurve(merchantId: string, atRiskPaise: number): Promise<number[]> {
    const flat = Array.from({ length: SPARKLINE_POINTS }, () => 0);
    if (atRiskPaise === 0) return flat;

    const recoveries = await this.prisma.case.findMany({
      where: { ...narratedCases(merchantId), recoveredAmountPaise: { gt: 0 } },
      select: { recoveredAmountPaise: true, updatedAt: true },
      orderBy: { updatedAt: "asc" },
    });

    if (recoveries.length === 0) return flat;

    const series: number[] = [];
    let running = 0;
    let cursor = 0;

    for (let point = 1; point <= SPARKLINE_POINTS; point += 1) {
      const upTo = Math.round((recoveries.length * point) / SPARKLINE_POINTS);
      for (; cursor < upTo; cursor += 1) running += recoveries[cursor].recoveredAmountPaise;
      series.push(round1((running / atRiskPaise) * 100));
    }

    return series;
  }
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** Midnight IST of the day `at` falls in, as a UTC instant. */
function istDayStart(at: Date): Date {
  const ist = at.getTime() + IST_OFFSET_MS;
  return new Date(Math.floor(ist / 86_400_000) * 86_400_000 - IST_OFFSET_MS);
}

function bucketIndex(at: Date, dayStart: Date): number {
  return Math.floor((at.getTime() - dayStart.getTime()) / (BUCKET_MINUTES * 60_000));
}

function bucketLabel(index: number): string {
  const hour = String(Math.floor(index / 2)).padStart(2, "0");
  return `${hour}:${index % 2 === 0 ? "00" : "30"}`;
}

function istClockLabel(at: Date): string {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  const hh = String(ist.getUTCHours()).padStart(2, "0");
  const mm = String(ist.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** Fills gaps with the last reading; a leading gap stays marked for the caller to resolve. */
function carryForward(rates: number[]): void {
  let last = NO_TRAFFIC;
  for (let index = 0; index < rates.length; index += 1) {
    if (rates[index] < 0) rates[index] = last;
    else last = rates[index];
  }
}
