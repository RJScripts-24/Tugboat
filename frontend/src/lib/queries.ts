import "server-only";

import { ApiError, apiFetch } from "./api";
import type {
  ApprovalHistoryRow,
  ApprovalRequest,
  ApprovalStats,
} from "./approvals-data";
import type {
  AuditFilters,
  CaseIndex,
  ChainTip,
  LedgerPage,
  LedgerRow,
  LedgerSummary,
} from "./audit-data";
import { GENESIS_HASH } from "./audit-data";
import type { CaseDetailWithNeighbours } from "./case-detail-data";
import type {
  ActivityEntry,
  CaseRow,
  FunnelStage,
  Kpis,
  RootCauseRow,
  ShellStatus,
  SuccessRateSeries,
} from "./dashboard-data";
import { toCaseRow } from "./dashboard-data";
import {
  CASE_TYPE_META,
  ROOT_CAUSE_META,
  type CaseFilters,
  type PipelineCase,
} from "./pipeline-data";
import type { PolicyResponse } from "./policies-data";
import type {
  EvidenceReport,
  PublicHeadline,
  RunStatus,
  SavedRun,
  SimulationConfig,
} from "./simulation-data";

/**
 * Every read the Control Tower does, in one place.
 *
 * They live here rather than beside the types they return for a reason
 * Next.js enforces rather than suggests: `lib/api.ts` reads the session from
 * `next/headers`, which only exists on the server, and a client component that
 * imports *anything* from a module which transitively imports it fails the
 * build. The metadata those client components need — `STAGE_META`, `TONE_HEX`,
 * `GATE_META`, the canonical vocabularies of build prompt §3.2 — lives in the
 * `*-data.ts` modules beside the types, and every one of those is now free of
 * the API client (D-119).
 *
 * `import "server-only"` at the top makes that boundary a build error rather
 * than a convention: a client component that reaches for a query here is told
 * so by the compiler, not by a reviewer.
 *
 * All of these are called from server components and route handlers. Writes go
 * through `lib/actions.ts`, which is the same seam from the other direction.
 */

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */

export function getKpis(): Promise<Kpis> {
  return apiFetch<Kpis>("/dashboard/kpis");
}

export function getFunnel(): Promise<FunnelStage[]> {
  return apiFetch<FunnelStage[]>("/dashboard/funnel");
}

export function getRecoveryByRootCause(): Promise<RootCauseRow[]> {
  return apiFetch<RootCauseRow[]>("/dashboard/root-causes");
}

export function getSuccessRateSeries(): Promise<SuccessRateSeries> {
  return apiFetch<SuccessRateSeries>("/dashboard/success-rate-series");
}

/**
 * The sidebar's counters.
 *
 * The pending-approvals figure deliberately does not come from here: it is
 * counted from the queue itself, because a count kept beside the thing it
 * counts is a count that eventually disagrees with it.
 */
export function getShellStatus(): Promise<ShellStatus> {
  return apiFetch<ShellStatus>("/dashboard/shell-status");
}

/**
 * The feed's opening page.
 *
 * A socket only carries what happens after it connects, so a page that
 * subscribed and nothing else would show an empty log until the next event —
 * which on a quiet merchant looks broken. These are the same rows the socket
 * will deliver, read through the same mapper on the server, so the line that
 * arrives live and the line that was already there are indistinguishable
 * (D-110).
 */
export function getSeedActivity(): Promise<ActivityEntry[]> {
  return apiFetch<ActivityEntry[]>("/dashboard/activity");
}

/** How many rows the Control Tower's table shows before "open the pipeline". */
const ACTIVE_ROWS = 10;

/**
 * The working list — what an operator actually scans.
 *
 * Projected from `GET /cases` rather than served as its own shape, because it
 * *is* the case list with different column names: the same rows the Pipeline
 * renders, narrowed to ten and relabelled. A second endpoint would be a second
 * query that could return a different answer to the same question.
 */
export async function getActiveCases(): Promise<CaseRow[]> {
  const { cases } = await apiFetch<{ cases: PipelineCase[] }>("/cases", {
    query: { take: ACTIVE_ROWS },
  });

  return cases.map(toCaseRow);
}

/* ------------------------------------------------------------------ */
/* Cases                                                               */
/* ------------------------------------------------------------------ */

/**
 * How many cases one page will render.
 *
 * The pipeline is a table an operator scans, not an export. A merchant with
 * five thousand open cases needs server-side paging rather than a longer list,
 * and this cap is what makes that need visible instead of quietly shipping a
 * ten-megabyte response.
 */
const MAX_BATCH = 500;

/**
 * The batch.
 *
 * Filtering is still done in the browser by `components/pipeline/filters.ts`,
 * and that is a deliberate choice rather than an oversight: the Pipeline's
 * filters live in the URL, compose freely, and an operator flipping between
 * "escalated" and "halted" should not wait for a round trip each time. The
 * endpoint takes every one of those filters too, which is what a batch too
 * large to send whole would use — noted here as the boundary it is rather than
 * left to be discovered at ten thousand cases (D-114).
 */
export async function getPipelineCases(filters: CaseFilters = {}): Promise<PipelineCase[]> {
  const { cases } = await apiFetch<{ cases: PipelineCase[]; total: number }>("/cases", {
    query: {
      stage: filters.stage?.join(","),
      type: filters.type?.join(","),
      cause: filters.cause?.join(","),
      search: filters.search,
      minPaise: filters.minPaise,
      maxPaise: filters.maxPaise,
      skip: filters.skip,
      take: filters.take ?? MAX_BATCH,
    },
  });

  return cases;
}

/**
 * One case, whole.
 *
 * Returns null for a case that does not exist, which the page turns into a
 * 404 — a page that answers for any URL is its own kind of lie. Anything else
 * going wrong is rethrown, because "the API is down" and "no such case" are
 * different answers and collapsing them would hide an outage behind a
 * not-found.
 */
export async function getCaseDetail(id: string): Promise<CaseDetailWithNeighbours | null> {
  try {
    return await apiFetch<CaseDetailWithNeighbours>(`/cases/${encodeURIComponent(id)}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Approvals                                                           */
/* ------------------------------------------------------------------ */

/** Pending requests, ordered by the money at risk — biggest question first. */
export async function getPendingApprovals(): Promise<ApprovalRequest[]> {
  const { approvals } = await apiFetch<{ approvals: ApprovalRequest[] }>("/approvals", {
    query: { status: "pending" },
  });
  return approvals;
}

/**
 * The count alone, for the sidebar badge.
 *
 * Counted from the queue rather than carried beside it. Once the page is open
 * the badge follows `approval.pending` and `approval.decided` frames, which
 * carry the queue depth whole rather than a delta (D-106).
 */
export async function getPendingApprovalCount(): Promise<number> {
  return (await getPendingApprovals()).length;
}

export async function getApprovalHistory(): Promise<ApprovalHistoryRow[]> {
  const { history } = await apiFetch<{ history: ApprovalHistoryRow[] }>("/approvals/history");
  return history;
}

export function getApprovalStats(): Promise<ApprovalStats> {
  return apiFetch<ApprovalStats>("/approvals/stats");
}

/* ------------------------------------------------------------------ */
/* Policies                                                            */
/* ------------------------------------------------------------------ */

/** The pack in force, its version, and every revision behind it — in one call. */
export function getPolicies(): Promise<PolicyResponse> {
  return apiFetch<PolicyResponse>("/policies");
}

/* ------------------------------------------------------------------ */
/* Audit                                                               */
/* ------------------------------------------------------------------ */

/**
 * How many rows one page of the Explorer holds.
 *
 * The table is virtualized, so this is about the response rather than the
 * render: a batch of 214 cases writes roughly three thousand rows, and the
 * whole ledger of a merchant running for a month is not a payload.
 */
const PAGE_SIZE = 2_000;

export function getLedgerPage(filters: AuditFilters = {}): Promise<LedgerPage> {
  return apiFetch<LedgerPage>("/audit", {
    query: {
      case: filters.case,
      chain: filters.chain,
      actor: filters.actor?.join(","),
      action: filters.action?.join(","),
      fromMs: filters.fromMs,
      toMs: filters.toMs,
      skip: filters.skip,
      take: filters.take ?? PAGE_SIZE,
    },
  });
}

export async function getLedger(filters: AuditFilters = {}): Promise<LedgerRow[]> {
  return (await getLedgerPage(filters)).rows;
}

/**
 * Where each chain stood when the page was rendered.
 *
 * Served by the API rather than derived from the page of rows on screen,
 * because a filtered page does not contain its chains' tips.
 */
export async function getLedgerTips(): Promise<Record<string, ChainTip>> {
  return (await getLedgerPage({ take: 1 })).tips;
}

export async function getChainTip(chain: string): Promise<ChainTip> {
  const tips = await getLedgerTips();
  return tips[chain] ?? { hash: GENESIS_HASH, seq: 0 };
}

/**
 * The Explorer's header figures, counted over the whole ledger.
 *
 * Deliberately not computed from the rows on screen. A page showing two
 * thousand of eleven thousand rows would otherwise announce "2,000 entries",
 * which is a true statement about the wrong thing.
 */
export function getLedgerSummary(): Promise<LedgerSummary> {
  return apiFetch<LedgerSummary>("/audit/summary");
}

/** How many rows the live ledger holds. The one number other pages may quote. */
export async function getLedgerSize(): Promise<number> {
  return (await getLedgerSummary()).entries;
}

/**
 * One line of context per case, so a ledger row is not just an id.
 *
 * Built from the case list rather than carried on every row: the same three
 * strings repeated across a case's twenty ledger rows would be twenty copies of
 * one fact, and the first to go stale would describe a case that has moved on.
 */
export async function getCaseIndex(): Promise<CaseIndex> {
  const index: CaseIndex = {};

  for (const record of await getPipelineCases()) {
    index[record.id] = {
      label: CASE_TYPE_META[record.type].short,
      cause: ROOT_CAUSE_META[record.rootCause].label,
      stage: record.stage,
    };
  }

  return index;
}

/* ------------------------------------------------------------------ */
/* Simulations                                                         */
/* ------------------------------------------------------------------ */

/**
 * Earlier runs, kept so a claim can be checked against a rerun rather than
 * taken on trust.
 */
export function getRunHistory(): Promise<SavedRun[]> {
  return apiFetch<SavedRun[]>("/simulations");
}

/** One run's status and its narration so far — what a reconnecting browser reads. */
export function getRunStatus(id: string): Promise<RunStatus> {
  return apiFetch<RunStatus>(`/simulations/${encodeURIComponent(id)}`);
}

/** The artifact, exactly as it was written. */
export function getReport(id: string): Promise<EvidenceReport> {
  return apiFetch<EvidenceReport>(`/simulations/${encodeURIComponent(id)}/report`);
}

/**
 * The report the Lab opens on.
 *
 * The promoted run first — that is the batch the rest of the Control Tower is
 * narrating, so the evidence page and the dashboard describe the same cases.
 * Failing that, the most recent completed run; failing that, nothing, and the
 * page says so rather than drawing an empty report.
 */
export async function getLatestReport(): Promise<{ run: SavedRun; report: EvidenceReport } | null> {
  const runs = await getRunHistory();
  const completed = runs.filter((run) => run.status === "COMPLETED");
  const chosen = completed.find((run) => run.current) ?? completed[0];

  if (!chosen) return null;

  return { run: chosen, report: await getReport(chosen.id) };
}

/**
 * The configuration the Run panel opens with.
 *
 * Taken from the run on screen where there is one, so pressing Run again
 * reproduces the batch a judge is looking at.
 */
export function getDefaultConfig(run?: SavedRun, report?: EvidenceReport): SimulationConfig {
  if (report) {
    return {
      batchSize: report.run.batchSize,
      mix: report.run.mix as SimulationConfig["mix"],
      difficulty: report.run.difficulty,
      seed: report.run.seed,
      arms: report.run.arms,
    };
  }

  return {
    batchSize: run?.batchSize ?? 214,
    mix: {
      PAYMENT_FAILED: 40,
      CHECKOUT_ABANDONED: 25,
      MANDATE_FAILED: 20,
      INVOICE_OVERDUE: 15,
    },
    difficulty: run?.difficulty ?? "realistic",
    seed: run?.seed ?? 42,
    arms: ["baseline", "naive", "tugboat"],
  };
}

/** Zeros, for a landing page rendered before any batch has been promoted. */
const NO_RUN: PublicHeadline = {
  runId: null,
  seed: null,
  recoveryRate: 0,
  upliftPoints: 0,
  accuracy: 0,
  atRiskPaise: 0,
  cases: 0,
};

/**
 * The four figures the landing page prints above the fold.
 *
 * The only unauthenticated read in the product, and the landing page is the
 * reason: a marketing number nobody can check is exactly the claim a payments
 * panel asks for the source of, so these come from the promoted run's own
 * report and carry its id (D-117).
 *
 * Falls back to zeros rather than throwing. The marketing site going down
 * because the API is restarting would be the wrong failure, and the row renders
 * an honest "no run yet" from them.
 */
export async function getPublicHeadline(): Promise<PublicHeadline> {
  try {
    return await apiFetch<PublicHeadline>("/simulations/headline");
  } catch {
    return NO_RUN;
  }
}
