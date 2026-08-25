import {
  computeStats,
  medianOf,
  type DecidedStatRow,
  type PendingStatRow,
} from "./approvals.stats";

const RUPEE = 100;

/**
 * Fifteen response times with a long tail, the same ladder the mock layer used.
 * Median 22s; mean 42s. The gap between those two numbers is the reason the
 * page prints a median.
 */
const LADDER = [7, 9, 11, 14, 16, 19, 21, 22, 26, 33, 41, 58, 74, 118, 186];

function decided(overrides: Partial<DecidedStatRow> = {}): DecidedStatRow {
  return {
    decision: "approved",
    latencySeconds: 22,
    atRiskPaise: 4_800 * RUPEE,
    recoveredPaise: 0,
    concessionPaise: 0,
    ...overrides,
  };
}

function pending(overrides: Partial<PendingStatRow> = {}): PendingStatRow {
  return { atRiskPaise: 4_800 * RUPEE, requestedMinutesAgo: 12, ...overrides };
}

describe("medianOf", () => {
  it("is the middle value on an odd count", () => {
    expect(medianOf(LADDER)).toBe(22);
  });

  it("is the rounded mean of the middle two on an even count", () => {
    expect(medianOf([10, 20, 30, 41])).toBe(25);
  });

  it("does not depend on the order it is handed", () => {
    expect(medianOf([186, 7, 22, 9, 41])).toBe(22);
  });

  it("does not mutate its input", () => {
    const rows = [3, 1, 2];
    medianOf(rows);
    expect(rows).toEqual([3, 1, 2]);
  });

  it("is zero when nothing has been decided", () => {
    expect(medianOf([])).toBe(0);
  });

  it("is resistant to the tail an average is not", () => {
    const mean = Math.round(LADDER.reduce((a, b) => a + b, 0) / LADDER.length);
    expect(medianOf(LADDER)).toBe(22);
    expect(mean).toBe(44);
  });
});

describe("computeStats — hand-computed against the rows underneath", () => {
  /**
   * Six decisions: four yeses (two of which recovered) and two noes. Every
   * figure below is worked out by hand in the assertion, so a change to the
   * function has to disagree with arithmetic rather than with a snapshot.
   */
  const history: DecidedStatRow[] = [
    decided({ latencySeconds: 7, atRiskPaise: 10_000 * RUPEE, recoveredPaise: 10_000 * RUPEE }),
    decided({
      latencySeconds: 21,
      atRiskPaise: 5_000 * RUPEE,
      recoveredPaise: 5_000 * RUPEE,
      concessionPaise: 600 * RUPEE,
    }),
    decided({ latencySeconds: 33, atRiskPaise: 8_000 * RUPEE }),
    decided({ latencySeconds: 118, atRiskPaise: 2_000 * RUPEE }),
    decided({ decision: "rejected", latencySeconds: 14, atRiskPaise: 30_000 * RUPEE }),
    decided({ decision: "rejected", latencySeconds: 58, atRiskPaise: 1_500 * RUPEE }),
  ];

  const queue: PendingStatRow[] = [
    pending({ atRiskPaise: 42_000 * RUPEE, requestedMinutesAgo: 6 }),
    pending({ atRiskPaise: 9_400 * RUPEE, requestedMinutesAgo: 143 }),
    pending({ atRiskPaise: 1_200 * RUPEE, requestedMinutesAgo: 27 }),
  ];

  const stats = computeStats(queue, history);

  it("counts the queue and the money sitting in it", () => {
    expect(stats.pending).toBe(3);
    expect(stats.pendingValuePaise).toBe((42_000 + 9_400 + 1_200) * RUPEE);
  });

  it("reports the longest wait, not the newest arrival", () => {
    expect(stats.oldestWaitMinutes).toBe(143);
  });

  it("splits the decisions and rates them", () => {
    expect(stats.decisions).toBe(6);
    expect(stats.approved).toBe(4);
    expect(stats.rejected).toBe(2);
    expect(stats.approvalRate).toBeCloseTo(4 / 6, 6);
  });

  it("takes the median and the worst case of the response times", () => {
    // Sorted: 7, 14, 21, 33, 58, 118 → (21 + 33) / 2 = 27.
    expect(stats.medianLatencySeconds).toBe(27);
    expect(stats.slowestLatencySeconds).toBe(118);
  });

  it("counts released value and what came back against it", () => {
    expect(stats.releasedValuePaise).toBe((10_000 + 5_000 + 8_000 + 2_000) * RUPEE);
    expect(stats.recoveredAfterApprovalPaise).toBe((10_000 + 5_000) * RUPEE);
    expect(stats.recoveredAfterApprovalCases).toBe(2);
    expect(stats.postApprovalRecoveryRate).toBeCloseTo(15_000 / 25_000, 6);
  });

  it("does not count a rejected case's value as released", () => {
    // The largest single number in the table is a ₹30,000 refusal. If it leaked
    // into releasedValuePaise the post-approval recovery rate would collapse
    // and read as the agent failing rather than the merchant declining.
    expect(stats.releasedValuePaise).toBeLessThan(30_000 * RUPEE);
  });

  it("sums only the concessions that were actually granted", () => {
    expect(stats.concessionPaise).toBe(600 * RUPEE);
  });
});

describe("computeStats — the empty and the extreme", () => {
  it("returns zeroes rather than NaN before the first decision", () => {
    const stats = computeStats([], []);

    expect(stats).toEqual({
      pending: 0,
      pendingValuePaise: 0,
      oldestWaitMinutes: 0,
      decisions: 0,
      approved: 0,
      rejected: 0,
      approvalRate: 0,
      medianLatencySeconds: 0,
      slowestLatencySeconds: 0,
      releasedValuePaise: 0,
      recoveredAfterApprovalPaise: 0,
      recoveredAfterApprovalCases: 0,
      postApprovalRecoveryRate: 0,
      concessionPaise: 0,
    });
  });

  it("does not divide by zero when every yes recovered nothing", () => {
    const stats = computeStats([], [decided({ atRiskPaise: 0, recoveredPaise: 0 })]);
    expect(stats.postApprovalRecoveryRate).toBe(0);
  });

  it("reports a perfect record honestly rather than capping it", () => {
    const stats = computeStats(
      [],
      [decided({ atRiskPaise: 1_000 * RUPEE, recoveredPaise: 1_000 * RUPEE })],
    );

    expect(stats.approvalRate).toBe(1);
    expect(stats.postApprovalRecoveryRate).toBe(1);
  });
});
