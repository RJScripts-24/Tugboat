/**
 * `GET /approvals/stats`, computed from the rows it describes.
 *
 * Nothing here is stored. A KPI kept beside the data it summarises is a KPI
 * that drifts from it the first time a row is written by a path that forgot to
 * update the counter — and on this page the drift would be silent, because
 * "median response time" has no obviously wrong value. Recomputing costs one
 * scan of a table that holds one row per human decision, which will never be
 * large; the alternative buys microseconds and sells the number's credibility.
 *
 * Shape matches the frontend's `ApprovalStats` exactly, median included: the
 * page prints what this returns and computes nothing of its own.
 */

export type PendingStatRow = {
  atRiskPaise: number;
  requestedMinutesAgo: number;
};

export type DecidedStatRow = {
  decision: "approved" | "rejected";
  latencySeconds: number;
  atRiskPaise: number;
  recoveredPaise: number;
  concessionPaise: number;
};

export type ApprovalStats = {
  pending: number;
  pendingValuePaise: number;
  oldestWaitMinutes: number;
  decisions: number;
  approved: number;
  rejected: number;
  approvalRate: number;
  medianLatencySeconds: number;
  slowestLatencySeconds: number;
  releasedValuePaise: number;
  recoveredAfterApprovalPaise: number;
  recoveredAfterApprovalCases: number;
  /** Of the value a yes released, how much actually came back. */
  postApprovalRecoveryRate: number;
  concessionPaise: number;
};

/**
 * The middle value, or the mean of the middle two.
 *
 * A median rather than an average because response times have a long tail — two
 * requests that sat for minutes would drag a mean far above the experience of
 * the other thirteen, and the number is meant to describe the typical decision.
 */
export function medianOf(values: number[]): number {
  if (values.length === 0) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length / 2;

  return sorted.length % 2 === 1
    ? sorted[(sorted.length - 1) / 2]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

export function computeStats(pending: PendingStatRow[], history: DecidedStatRow[]): ApprovalStats {
  const approved = history.filter((row) => row.decision === "approved");
  const latencies = history.map((row) => row.latencySeconds).sort((a, b) => a - b);

  const releasedPaise = approved.reduce((sum, row) => sum + row.atRiskPaise, 0);
  const recoveredPaise = approved.reduce((sum, row) => sum + row.recoveredPaise, 0);

  return {
    pending: pending.length,
    pendingValuePaise: pending.reduce((sum, row) => sum + row.atRiskPaise, 0),
    oldestWaitMinutes: pending.reduce((max, row) => Math.max(max, row.requestedMinutesAgo), 0),
    decisions: history.length,
    approved: approved.length,
    rejected: history.length - approved.length,
    approvalRate: history.length === 0 ? 0 : approved.length / history.length,
    medianLatencySeconds: medianOf(latencies),
    slowestLatencySeconds: latencies[latencies.length - 1] ?? 0,
    releasedValuePaise: releasedPaise,
    recoveredAfterApprovalPaise: recoveredPaise,
    recoveredAfterApprovalCases: approved.filter((row) => row.recoveredPaise > 0).length,
    postApprovalRecoveryRate: releasedPaise === 0 ? 0 : recoveredPaise / releasedPaise,
    concessionPaise: history.reduce((sum, row) => sum + row.concessionPaise, 0),
  };
}
