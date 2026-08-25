import { BUCKET_MINUTES, bucketFor, mean, stdDev } from "./detector.service";

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
