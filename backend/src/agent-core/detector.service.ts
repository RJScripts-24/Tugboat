import { Injectable, Logger } from "@nestjs/common";

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
const MIN_BASELINE_BUCKETS = 4;
/** A bank never dips by a hair; this stops a statistically-significant 1% wobble tripping. */
const MIN_DROP_POINTS = 5;

export type DegradationVerdict = {
  degraded: boolean;
  windowRate: number;
  baselineRate: number;
  zScore: number;
  windowSamples: number;
  reason: string;
};

export function bucketFor(at: Date, minutes = BUCKET_MINUTES): Date {
  const ms = minutes * 60_000;
  return new Date(Math.floor(at.getTime() / ms) * ms);
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
   * Compares the recent window against its own trailing baseline.
   *
   * A z-score answers "how unusual is this dip, in units of this gateway's own
   * normal variation?" — which is the right question, because a payment method
   * that always sits at 94% ± 1 is in trouble at 88%, while one that swings
   * between 70% and 99% is not.
   */
  async evaluate(merchantId: string, now = new Date()): Promise<DegradationVerdict> {
    const horizon = new Date(
      bucketFor(now).getTime() - (WINDOW_BUCKETS + BASELINE_BUCKETS) * BUCKET_MINUTES * 60_000,
    );

    const samples = await this.prisma.paymentSample.findMany({
      where: { merchantId, at: { gte: horizon } },
      select: { bucket: true, success: true },
    });

    const byBucket = new Map<number, { total: number; ok: number }>();
    for (const sample of samples) {
      const key = sample.bucket.getTime();
      const entry = byBucket.get(key) ?? { total: 0, ok: 0 };
      entry.total += 1;
      if (sample.success) entry.ok += 1;
      byBucket.set(key, entry);
    }

    const ordered = [...byBucket.entries()].sort((a, b) => a[0] - b[0]);
    const windowEntries = ordered.slice(-WINDOW_BUCKETS);
    const baselineEntries = ordered.slice(0, Math.max(0, ordered.length - WINDOW_BUCKETS));

    const windowSamples = windowEntries.reduce((sum, [, e]) => sum + e.total, 0);
    const windowOk = windowEntries.reduce((sum, [, e]) => sum + e.ok, 0);
    const windowRate = windowSamples === 0 ? 100 : (windowOk / windowSamples) * 100;

    const baselineRates = baselineEntries
      .filter(([, e]) => e.total > 0)
      .map(([, e]) => (e.ok / e.total) * 100);

    if (windowSamples < MIN_WINDOW_SAMPLES || baselineRates.length < MIN_BASELINE_BUCKETS) {
      return {
        degraded: false,
        windowRate,
        baselineRate: mean(baselineRates),
        zScore: 0,
        windowSamples,
        reason: "Not enough history to call a dip",
      };
    }

    const baselineRate = mean(baselineRates);
    // A perfectly steady baseline has zero deviation, which would divide by
    // zero and call every dip infinitely significant. One point is the floor.
    const deviation = Math.max(stdDev(baselineRates), 1);
    const zScore = (windowRate - baselineRate) / deviation;
    const drop = baselineRate - windowRate;

    const degraded = zScore <= Z_THRESHOLD && drop >= MIN_DROP_POINTS;

    return {
      degraded,
      windowRate: round(windowRate),
      baselineRate: round(baselineRate),
      zScore: round(zScore),
      windowSamples,
      reason: degraded
        ? `Success rate ${round(windowRate)}% against a ${round(baselineRate)}% baseline (z ${round(zScore)})`
        : `Within normal variation (z ${round(zScore)})`,
    };
  }

  /**
   * Opens an incident when the gateway dips, closes it when it recovers.
   *
   * Idempotent: while an incident is open a further dip updates it rather than
   * opening a second, so a fifteen-minute outage is one incident on the
   * dashboard and not forty.
   */
  async syncIncident(merchantId: string, now = new Date()) {
    const verdict = await this.evaluate(merchantId, now);
    const open = await this.openIncident(merchantId);

    if (verdict.degraded && !open) {
      const incident = await this.prisma.degradationIncident.create({
        data: {
          merchantId,
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

    if (!verdict.degraded && open) {
      const incident = await this.prisma.degradationIncident.update({
        where: { id: open.id },
        data: { recoveredAt: now },
      });
      this.logger.log(`Gateway degradation recovered after ${verdict.reason}`);
      return { verdict, incident: null, recovered: incident };
    }

    return { verdict, incident: open };
  }

  openIncident(merchantId: string) {
    return this.prisma.degradationIncident.findFirst({
      where: { merchantId, recoveredAt: null },
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
