import {
  BUCKET_MINUTES,
  binomialTail,
  bucketFor,
  evaluationBounds,
  judge,
  mean,
  sampleScope,
  stdDev,
} from "./detector.service";

describe("detector statistics", () => {
  describe("bucketing", () => {
    it("floors a timestamp to its 5-minute bucket", () => {
      expect(bucketFor(new Date("2026-08-24T14:32:47.512Z")).toISOString()).toBe(
        "2026-08-24T14:30:00.000Z",
      );
    });

    it("puts everything inside one bucket in the same bucket", () => {
      const a = bucketFor(new Date("2026-08-24T14:30:00.000Z"));
      const b = bucketFor(new Date("2026-08-24T14:34:59.999Z"));
      expect(a.getTime()).toBe(b.getTime());
    });

    it("starts a new bucket exactly on the boundary", () => {
      const a = bucketFor(new Date("2026-08-24T14:34:59.999Z"));
      const b = bucketFor(new Date("2026-08-24T14:35:00.000Z"));
      expect(b.getTime() - a.getTime()).toBe(BUCKET_MINUTES * 60_000);
    });
  });

  describe("mean and deviation", () => {
    it("averages a series", () => {
      expect(mean([94, 95, 96])).toBe(95);
    });

    it("returns zero for an empty series rather than NaN", () => {
      expect(mean([])).toBe(0);
      expect(stdDev([])).toBe(0);
      expect(stdDev([94])).toBe(0);
    });

    it("measures spread, so a steady gateway and a swinging one differ", () => {
      const steady = stdDev([94, 94.2, 93.8, 94.1, 94]);
      const swinging = stdDev([70, 99, 82, 95, 74]);

      expect(steady).toBeLessThan(1);
      expect(swinging).toBeGreaterThan(10);
    });
  });

  describe("the z-score is why the spread matters", () => {
    // A dip to 88% is an emergency on a gateway that never leaves 94±0.5,
    // and unremarkable on one that swings between 70 and 99. The same absolute
    // drop must therefore produce very different scores.
    function z(window: number, baseline: number[]): number {
      return (window - mean(baseline)) / Math.max(stdDev(baseline), 1);
    }

    it("flags a small drop on a steady gateway", () => {
      expect(z(88, [94, 94.2, 93.8, 94.1, 94])).toBeLessThan(-3);
    });

    it("shrugs at the same drop on a volatile gateway", () => {
      expect(z(88, [70, 99, 82, 95, 74])).toBeGreaterThan(-3);
    });

    it("cannot divide by zero on a perfectly flat baseline", () => {
      expect(Number.isFinite(z(88, [94, 94, 94, 94]))).toBe(true);
    });
  });
});

describe("sampleScope — what a verdict at `now` may read (D-142)", () => {
  const now = new Date("2026-08-05T09:07:30.000Z");

  it("reads the window and its baseline, and nothing after now", () => {
    const scope = sampleScope("m1", now, null);
    const at = scope.at as { gte: Date; lte: Date };

    // A rolling fifteen-minute window back from `now` (08:52:30), and the
    // twelve complete buckets before it: 08:50 back to 07:50.
    expect(at.gte.toISOString()).toBe("2026-08-05T07:50:00.000Z");
    expect(at.lte).toBe(now);
  });

  it("freezes the baseline before an open incident's own window (D-143)", () => {
    const detectedAt = new Date("2026-08-05T08:12:00.000Z");
    const bounds = evaluationBounds(now, detectedAt);

    // The window still ends at `now`; the baseline is the hour before the
    // window that detected the incident (07:57 → bucket 07:55), not the hour
    // before `now`.
    expect(bounds.windowStart.toISOString()).toBe("2026-08-05T08:52:30.000Z");
    expect(bounds.baselineEnd.toISOString()).toBe("2026-08-05T07:55:00.000Z");
    expect(bounds.baselineStart.toISOString()).toBe("2026-08-05T06:55:00.000Z");
    expect(sampleScope("m1", now, null, detectedAt).at).toMatchObject({ gte: bounds.baselineStart, lte: now });
  });

  it("uses the complete buckets before the window when nothing is open", () => {
    const bounds = evaluationBounds(now, null);
    expect(bounds.baselineEnd.toISOString()).toBe("2026-08-05T08:50:00.000Z");
    expect(bounds.baselineEnd.getTime()).toBeLessThanOrEqual(bounds.windowStart.getTime());
  });

  it("scopes the live monitor to live traffic", () => {
    expect(sampleScope("m1", now, null)).toMatchObject({ merchantId: "m1", simRunId: null });
  });

  it("scopes a batch's monitor to that batch's traffic", () => {
    expect(sampleScope("m1", now, "run-7")).toMatchObject({ merchantId: "m1", simRunId: "run-7" });
  });
});

describe("binomialTail", () => {
  it("is certain of at least zero failures", () => {
    expect(binomialTail(10, 0, 0.1)).toBe(1);
  });

  it("matches the small cases by hand", () => {
    expect(binomialTail(2, 2, 0.5)).toBeCloseTo(0.25, 6);
    expect(binomialTail(3, 1, 0.5)).toBeCloseTo(0.875, 6);
  });
});

describe("judge — when a dip opens and when it closes (D-143)", () => {
  const steady = [97, 98, 96, 97];

  it("does not open on three failures in twenty-three attempts — chance at this volume", () => {
    const verdict = judge(23, 20, [98, 99, 97, 99]);
    expect(verdict.sufficient).toBe(true);
    expect(verdict.degraded).toBe(false);
    expect(verdict.tail).toBeGreaterThan(0.001);
  });

  it("opens when half of sixteen attempts fail", () => {
    const verdict = judge(16, 8, steady);
    expect(verdict.degraded).toBe(true);
    expect(verdict.tail).toBeLessThan(0.001);
    expect(verdict.reason).toMatch(/against a 97% baseline/);
  });

  it("does not close while the window is still well below the baseline", () => {
    const verdict = judge(16, 12, [75, 90, 95, 92]);
    expect(verdict.sufficient).toBe(true);
    expect(verdict.degraded).toBe(false);
    expect(verdict.recovered).toBe(false);
  });

  it("closes once the window is back within noise of the baseline", () => {
    expect(judge(20, 17, [75, 90, 95, 92]).recovered).toBe(true);
  });

  it("floors the spread at the window's own sampling error", () => {
    // Two failures in fifteen on a gateway whose baseline never moves: z would
    // be −10 against a one-point floor; against sampling noise it is chance.
    const verdict = judge(15, 13, [97, 97, 97, 97]);
    expect(verdict.degraded).toBe(false);
  });

  it("calls thin data insufficient rather than recovered", () => {
    const verdict = judge(8, 4, [97, 98, 96]);
    expect(verdict.sufficient).toBe(false);
    expect(verdict.recovered).toBe(false);
    expect(verdict.degraded).toBe(false);
  });
});
