import { Injectable, Logger } from "@nestjs/common";
import type { Prisma } from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";

/**
 * Payment-degradation detection (PRD 7.7).
 *
 * Deliberately simple statistics, not a trained model: a rolling success rate
 * compared against its own recent baseline with a z-score. It is explainable in
 * one sentence to a panelist, has no training data to justify, and cannot drift.
 */

export const BUCKET_MINUTES = 5;
/** The recent window under test: three buckets, so a blip needs to persist. */
const WINDOW_BUCKETS = 3;
/** Trailing buckets that define "normal" — an hour of history. */
const BASELINE_BUCKETS = 12;
/** How far below normal counts as a real dip rather than noise. */
const Z_THRESHOLD = -3;
/** Below this many samples the rate is noise, whatever the arithmetic says. */
const MIN_WINDOW_SAMPLES = 12;
/** The baseline is read as fifteen-minute windows — the same resolution as the window under test (D-143). */
const MIN_BASELINE_WINDOWS = 3;
/** A bank never dips by a hair; this stops a statistically-significant 1% wobble tripping. */
const MIN_DROP_POINTS = 5;
/** The window's failures must be this unlikely at the baseline rate before a dip is called (exact binomial tail). */
const ALPHA = 0.001;
/** An open incident closes only once the window is back within noise of the baseline — hysteresis, so a 47-point drop at z −2.98 is not "recovered". */
const RECOVERY_Z = -1;

export type DegradationVerdict = {
  /** The opening test: unusual against this gateway's own spread, at least five points, and not chance. */
  degraded: boolean;
  /** The closing test: back within noise of the baseline. Distinct from `!degraded` on purpose (hysteresis). */
  recovered: boolean;
  /** False when the window or the baseline was too thin to judge — which is not evidence of anything. */
  sufficient: boolean;
  windowRate: number;
  baselineRate: number;
  zScore: number;
  /** P(at least this many failures | the baseline rate) — the exact binomial tail. */
  tail: number;
  windowSamples: number;
  reason: string;
};

export function bucketFor(at: Date, minutes = BUCKET_MINUTES): Date {
  const ms = minutes * 60_000;
  return new Date(Math.floor(at.getTime() / ms) * ms);
}

/**
 * Which samples a verdict at `now` may read: the window, its baseline, and
 * nothing after `now`. A batch seeds its whole traffic up front, so a monitor
 * that read forward judged every dip by the recovery that followed it and never
 * fired (B-67). One traffic stream only — the live gateway's, or one batch's —
 * because streams on different clocks would pollute each other (D-142).
 */
export function sampleScope(
  merchantId: string,
  now: Date,
  simRunId: string | null,
  baselineEndsAt: Date | null = null,
): Prisma.PaymentSampleWhereInput {
  const { baselineStart } = evaluationBounds(now, baselineEndsAt);
  return { merchantId, simRunId, at: { gte: baselineStart, lte: now } };
}

/**
 * The two spans a verdict compares. The window is the last fifteen minutes up
 * to `now` — rolling, not bucket-aligned, because at a bucket boundary "the
 * last three buckets" holds an empty current bucket and the window starves.
 * The baseline is the twelve complete buckets before the window — or, while an
 * incident is open, the twelve before the window that *detected* it: a
 * baseline that slides through an outage absorbs it within the hour and calls
 * it recovered while it is still going, so recovery is judged against what
 * normal was before it started (D-143).
 */
export function evaluationBounds(
  now: Date,
  baselineEndsAt: Date | null,
): { baselineStart: Date; baselineEnd: Date; windowStart: Date } {
  const bucket = BUCKET_MINUTES * 60_000;
  const windowStart = new Date(now.getTime() - WINDOW_BUCKETS * bucket);
  const baselineEnd = bucketFor(
    baselineEndsAt ? new Date(baselineEndsAt.getTime() - WINDOW_BUCKETS * bucket) : windowStart,
  );
  const baselineStart = new Date(baselineEnd.getTime() - BASELINE_BUCKETS * bucket);
  return { baselineStart, baselineEnd, windowStart };
}

/** P(X ≥ k) for X ~ Binomial(n, q), summed in log space so n in the hundreds is fine. */
export function binomialTail(n: number, k: number, q: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  const p = Math.min(0.999999, Math.max(0.000001, q));
  let tail = 0;
  for (let i = k; i <= n; i += 1) {
    let logChoose = 0;
    for (let j = 1; j <= i; j += 1) logChoose += Math.log(n - i + j) - Math.log(j);
    tail += Math.exp(logChoose + i * Math.log(p) + (n - i) * Math.log(1 - p));
  }
  return Math.min(1, tail);
}

/**
 * The verdict, as arithmetic on three numbers. Opening needs all three
 * guards: the window is unusual against the gateway's own spread (z ≤ −3), the
 * drop is at least five points, and the failures are not chance at the
 * baseline rate (exact binomial tail ≤ α). The spread is floored at the
 * sampling error of a window this size — fifteen attempts cannot resolve a
 * five-point dip, and the monitor knows it. Closing is a different, looser
 * test (z > −1): an outage that has eased from 50% to 75% has not recovered.
 */
export function judge(windowSamples: number, windowOk: number, baselineRates: number[]): DegradationVerdict {
  const windowRate = windowSamples === 0 ? 100 : (windowOk / windowSamples) * 100;

  if (windowSamples < MIN_WINDOW_SAMPLES || baselineRates.length < MIN_BASELINE_WINDOWS) {
    return {
      degraded: false,
      recovered: false,
      sufficient: false,
      windowRate: round(windowRate),
      baselineRate: round(mean(baselineRates)),
      zScore: 0,
      tail: 1,
      windowSamples,
      reason: "Not enough history to call a dip",
    };
  }

  const baselineRate = mean(baselineRates);
  const p = Math.min(0.999, Math.max(0.001, baselineRate / 100));
  const samplingError = 100 * Math.sqrt((p * (1 - p)) / windowSamples);
  const deviation = Math.max(stdDev(baselineRates), 1, samplingError);
  const zScore = (windowRate - baselineRate) / deviation;
  const drop = baselineRate - windowRate;
  const tail = binomialTail(windowSamples, windowSamples - windowOk, 1 - p);

  const degraded = zScore <= Z_THRESHOLD && drop >= MIN_DROP_POINTS && tail <= ALPHA;
  const recovered = zScore > RECOVERY_Z || drop < MIN_DROP_POINTS;

  return {
    degraded,
    recovered,
    sufficient: true,
    windowRate: round(windowRate),
    baselineRate: round(baselineRate),
    zScore: round(zScore),
    tail,
    windowSamples,
    reason: degraded
      ? `Success rate ${round(windowRate)}% against a ${round(baselineRate)}% baseline (z ${round(zScore)}, p ${tail.toExponential(1)})`
      : recovered
        ? `Within normal variation (z ${round(zScore)})`
        : `Still below the baseline (z ${round(zScore)})`,
  };
}

export function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

@Injectable()
export class DetectorService {
  private readonly logger = new Logger(DetectorService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records one payment outcome.
   *
   * Successes matter as much as failures: a burst of failures means nothing
   * without knowing how many payments went through beside them, and a detector
   * that only ever sees failures will conclude the gateway is always broken.
   */
  async recordOutcome(input: {
    merchantId: string;
    success: boolean;
    at?: Date;
    method?: string | null;
    bank?: string | null;
    simRunId?: string | null;
  }): Promise<void> {
    const at = input.at ?? new Date();

    await this.prisma.paymentSample.create({
      data: {
        merchantId: input.merchantId,
        at,
        bucket: bucketFor(at),
        success: input.success,
        method: input.method ?? undefined,
        bank: input.bank ?? undefined,
        simRunId: input.simRunId ?? undefined,
      },
    });
  }

  /**
   * Records many outcomes at once.
   *
   * A simulated batch needs a denominator: two hundred failures with no
   * successes beside them describe a gateway that is permanently on fire, and
   * every case would then be diagnosed as a degradation. Writing those
   * background samples one row at a time is thousands of round trips for data
   * nothing reads individually, so they go in one statement.
   */
  async recordOutcomes(
    samples: {
      merchantId: string;
      success: boolean;
      at: Date;
      method?: string | null;
      bank?: string | null;
      simRunId?: string | null;
    }[],
  ): Promise<number> {
    if (samples.length === 0) return 0;

    const created = await this.prisma.paymentSample.createMany({
      data: samples.map((sample) => ({
        merchantId: sample.merchantId,
        at: sample.at,
        bucket: bucketFor(sample.at),
        success: sample.success,
        method: sample.method ?? undefined,
        bank: sample.bank ?? undefined,
        simRunId: sample.simRunId ?? undefined,
      })),
    });

    return created.count;
  }

  /**
   * Compares the recent window against its own trailing baseline.
   *
   * A z-score answers "how unusual is this dip, in units of this gateway's own
   * normal variation?" — which is the right question, because a payment method
   * that always sits at 94% ± 1 is in trouble at 88%, while one that swings
   * between 70% and 99% is not.
   */
  async evaluate(
    merchantId: string,
    now = new Date(),
    simRunId: string | null = null,
    baselineEndsAt: Date | null = null,
  ): Promise<DegradationVerdict> {
    const samples = await this.prisma.paymentSample.findMany({
      where: sampleScope(merchantId, now, simRunId, baselineEndsAt),
      select: { at: true, bucket: true, success: true },
    });
    const bounds = evaluationBounds(now, baselineEndsAt);

    const byBucket = new Map<number, { total: number; ok: number }>();
    let windowSamples = 0;
    let windowOk = 0;
    for (const sample of samples) {
      if (sample.at.getTime() > bounds.windowStart.getTime()) {
        windowSamples += 1;
        if (sample.success) windowOk += 1;
        continue;
      }
      const key = sample.bucket.getTime();
      if (key < bounds.baselineStart.getTime() || key >= bounds.baselineEnd.getTime()) continue;
      const entry = byBucket.get(key) ?? { total: 0, ok: 0 };
      entry.total += 1;
      if (sample.success) entry.ok += 1;
      byBucket.set(key, entry);
    }

    // The baseline's twelve buckets are read as four fifteen-minute windows,
    // so its spread is measured at the same resolution as the window under
    // test. Five samples in a five-minute bucket swing by ten points on their
    // own; compared like with like, a steady gateway looks steady (D-143).
    const bucket = BUCKET_MINUTES * 60_000;
    const baselineRates: number[] = [];
    for (let w = 0; w < BASELINE_BUCKETS / WINDOW_BUCKETS; w += 1) {
      let total = 0;
      let ok = 0;
      for (let b = 0; b < WINDOW_BUCKETS; b += 1) {
        const entry = byBucket.get(bounds.baselineStart.getTime() + (w * WINDOW_BUCKETS + b) * bucket);
        if (entry) {
          total += entry.total;
          ok += entry.ok;
        }
      }
      if (total > 0) baselineRates.push((ok / total) * 100);
    }

    return judge(windowSamples, windowOk, baselineRates);
  }

  /**
   * Opens an incident when the gateway dips, closes it when it recovers.
   *
   * Idempotent: while an incident is open a further dip updates it rather than
   * opening a second, so a fifteen-minute outage is one incident on the
   * dashboard and not forty.
   */
  async syncIncident(merchantId: string, now = new Date(), simRunId: string | null = null) {
    const open = await this.openIncident(merchantId, simRunId);
    const verdict = await this.evaluate(merchantId, now, simRunId, open?.detectedAt ?? null);

    if (verdict.degraded && !open) {
      const incident = await this.prisma.degradationIncident.create({
        data: {
          merchantId,
          simRunId,
          detectedAt: now,
          windowRate: verdict.windowRate,
          baselineRate: verdict.baselineRate,
          zScore: verdict.zScore,
          note: verdict.reason,
        },
      });
      this.logger.warn(`Gateway degradation detected: ${verdict.reason}`);
      return { verdict, incident };
    }

    if (verdict.sufficient && verdict.recovered && open) {
      const incident = await this.prisma.degradationIncident.update({
        where: { id: open.id },
        data: { recoveredAt: now },
      });
      this.logger.log(`Gateway degradation recovered after ${verdict.reason}`);
      return { verdict, incident: null, recovered: incident };
    }

    return { verdict, incident: open };
  }

  openIncident(merchantId: string, simRunId: string | null = null) {
    return this.prisma.degradationIncident.findFirst({
      where: { merchantId, simRunId, recoveredAt: null },
      orderBy: { detectedAt: "desc" },
    });
  }

  /** Attributes a case to the incident that explains it, for the dashboard's count. */
  async attachCase(incidentId: string, caseId: number): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.case.update({ where: { id: caseId }, data: { degradationIncidentId: incidentId } }),
      this.prisma.degradationIncident.update({
        where: { id: incidentId },
        data: { casesOpened: { increment: 1 } },
      }),
    ]);
  }
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
