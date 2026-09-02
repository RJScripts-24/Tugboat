"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { ChalkRule } from "@/components/dashboard/chalk";
import { ChevronRightIcon, DownloadIcon } from "@/components/dashboard/icons";
import { MoneyValue } from "@/components/dashboard/primitives";
import { formatPercent } from "@/lib/money";
import {
  CASE_TYPE_ORDER,
  STAGE_META,
  formatAge,
  type CaseType,
  type PipelineCase,
  type Stage,
} from "@/lib/pipeline-data";
import { FilterBar } from "./filter-bar";
import {
  PAGE_SIZE,
  applyFilters,
  applySort,
  chipsFor,
  readFilters,
  readPage,
  readSort,
  type HrefPatch,
} from "./filters";
import { PipelineTable } from "./pipeline-table";

/**
 * Recovery Pipeline (PRD 6.3, page 3) - every at-risk rupee as a workable list.
 *
 * The Control Tower answers "how is the batch doing"; this page answers "which
 * of these would I touch". It therefore holds the whole batch rather than a
 * sample, and its state lives in the URL so the funnel upstairs can link
 * straight into a pre-filtered view of it.
 *
 * The figures across the top are computed from the rows actually on screen, not
 * fetched separately. That is deliberate: a summary that can disagree with the
 * list beneath it is a summary nobody can trust, and this one cannot drift by
 * construction.
 */
export function PipelineView({
  cases,
  seed,
  policyVersion,
}: {
  cases: PipelineCase[];
  /** The promoted run's seed, or 0 when this data did not come from a run. */
  seed: number;
  /** The pack actually in force, read from `GET /policies` by the page. */
  policyVersion: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const params = useMemo(() => new URLSearchParams(searchParams.toString()), [searchParams]);
  const filters = useMemo(() => readFilters(params), [params]);
  const sort = useMemo(() => readSort(params), [params]);
  const page = readPage(params);
  const highlighted = params.get("case");

  /**
   * Any change to a filter, a sort or a search resets paging: page 7 of a
   * different list is a page nobody asked for.
   */
  const buildHref = useCallback(
    (patch: HrefPatch) => {
      const next = new URLSearchParams(params.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value == null || value === "") next.delete(key);
        else next.set(key, value);
      }
      if (!("page" in patch)) next.delete("page");
      const query = next.toString();
      return query ? `${pathname}?${query}` : pathname;
    },
    [params, pathname],
  );

  const onSearch = useCallback(
    (value: string) => {
      // replace, not push: a search term should not bury the previous page in
      // history one keystroke at a time.
      router.replace(buildHref({ q: value || null, case: null }), { scroll: false });
    },
    [buildHref, router],
  );

  const flashed = useFlashOnMove(cases);

  const rows = useMemo(
    () => applySort(applyFilters(cases, filters), sort),
    [cases, filters, sort],
  );

  const totals = useMemo(() => summarise(rows), [rows]);
  const counts = useMemo(() => countTypes(cases), [cases]);
  const chips = useMemo(() => chipsFor(filters, buildHref), [filters, buildHref]);

  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const start = (current - 1) * PAGE_SIZE;
  const visible = rows.slice(start, start + PAGE_SIZE);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Both figures were literals — "seed 42" over whatever run is
            promoted, and "policy v4" while the top bar three inches above read
            the pack actually in force. One fact, two numbers, one screen. */}
        <p className="mono text-[12px] text-txt-faint">
          {seed > 0 ? `seed ${seed} · ` : ""}
          {cases.length} cases · contacts masked · every outbound action gated by {policyVersion}
        </p>
        <ExportButton rows={rows} />
      </div>

      <SummaryStrip totals={totals} batchSize={cases.length} />

      <section className="surface">
        <div className="px-4 py-3.5 sm:px-5">
          <FilterBar
            filters={filters}
            buildHref={buildHref}
            onSearch={onSearch}
            counts={counts}
            activeChips={chips}
          />
        </div>

        <ChalkRule />

        {visible.length > 0 ? (
          <PipelineTable
            rows={visible}
            sort={sort}
            buildHref={buildHref}
            flashed={flashed}
            highlighted={highlighted}
          />
        ) : (
          <EmptyState cleared={buildHref({ type: null, stage: null, cause: null, band: null, q: null, case: null })} />
        )}

        {rows.length > PAGE_SIZE ? (
          <>
            <ChalkRule />
            <Pager
              start={start}
              shown={visible.length}
              total={rows.length}
              page={current}
              pages={pages}
              buildHref={buildHref}
            />
          </>
        ) : null}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Live stage movement                                                 */
/* ------------------------------------------------------------------ */

/**
 * Flashes the rows that actually moved.
 *
 * This used to be a `setInterval` walking a canned list of eight legal
 * transitions and applying them to whichever case was next in line - a case
 * promoted to `recovered` every 5.2 seconds, its full amount written into
 * `recoveredPaise`, and the whole invention folded into the summary strip above
 * and the CSV export below. It stood in for the `case.updated` room while that
 * room was being built, and then outlived it.
 *
 * The room exists. `<LiveRefresh>` re-runs the server read on `case.updated`,
 * so a real transition arrives as a new `cases` prop. All this has to do is
 * notice which stage changed between one prop and the next, which is the only
 * thing the animation was ever needed for: a list that redraws with no signal
 * reads as a list that did not change.
 */
function useFlashOnMove(cases: PipelineCase[]): Set<string> {
  const seen = useRef<Map<string, Stage> | null>(null);
  const [flashed, setFlashed] = useState<Set<string>>(new Set());

  useEffect(() => {
    const next = new Map(cases.map((row) => [row.id, row.stage]));
    const previous = seen.current;
    seen.current = next;

    // First render is not a movement: every row would flash at once.
    if (previous === null) return;

    const moved = new Set<string>();
    for (const [id, stage] of next) {
      const before = previous.get(id);
      if (before !== undefined && before !== stage) moved.add(id);
    }

    if (moved.size > 0) setFlashed(moved);
  }, [cases]);

  // The flash is a signal that something changed, so it has to expire; a row
  // left highlighted reads as a selection.
  useEffect(() => {
    if (flashed.size === 0) return;
    const id = setTimeout(() => setFlashed(new Set()), 1_400);
    return () => clearTimeout(id);
  }, [flashed]);

  return flashed;
}

/* ------------------------------------------------------------------ */
/* Summary                                                             */
/* ------------------------------------------------------------------ */

type Totals = {
  cases: number;
  atRiskPaise: number;
  recoveredPaise: number;
  recoveredCases: number;
  inFlight: number;
  escalated: number;
  halted: number;
  exhausted: number;
};

function summarise(rows: PipelineCase[]): Totals {
  const totals: Totals = {
    cases: rows.length,
    atRiskPaise: 0,
    recoveredPaise: 0,
    recoveredCases: 0,
    inFlight: 0,
    escalated: 0,
    halted: 0,
    exhausted: 0,
  };

  for (const row of rows) {
    totals.atRiskPaise += row.amountPaise;
    totals.recoveredPaise += row.recoveredPaise;
    if (row.stage === "recovered") totals.recoveredCases += 1;
    if (STAGE_META[row.stage].group === "open") totals.inFlight += 1;
    if (row.stage === "escalated") totals.escalated += 1;
    if (row.stage === "halted") totals.halted += 1;
    if (row.stage === "exhausted") totals.exhausted += 1;
  }

  return totals;
}

function countTypes(cases: PipelineCase[]) {
  const byType = Object.fromEntries(CASE_TYPE_ORDER.map((type) => [type, 0])) as Record<
    CaseType,
    number
  >;
  for (const row of cases) byType[row.type] += 1;
  return { total: cases.length, byType };
}

/**
 * Four figures for the rows on screen.
 *
 * Same hand as the Control Tower's metrics strip, one notch quieter: this is a
 * read-out of the current filter, not the headline of the product.
 */
function SummaryStrip({ totals, batchSize }: { totals: Totals; batchSize: number }) {
  const stopped = totals.halted + totals.exhausted;
  // By value, not by case count - it has to reconcile with the recovery rate
  // on the Control Tower, which is rupees back over rupees at risk.
  const rate = totals.atRiskPaise === 0 ? 0 : totals.recoveredPaise / totals.atRiskPaise;

  return (
    <section
      aria-label="Figures for the cases in view"
      className="grid grid-cols-2 xl:grid-cols-4"
    >
      <Figure
        label="Cases in view"
        value={<span className="tabular">{totals.cases}</span>}
        support={
          totals.cases === batchSize
            ? "the whole seeded batch"
            : `of ${batchSize} · ${share(totals.cases / batchSize)} of the batch`
        }
      />
      <Figure
        label="At risk in view"
        value={<MoneyValue paise={totals.atRiskPaise} />}
        support={`${totals.inFlight} still in flight · ${totals.escalated} with a human`}
      />
      <Figure
        label="Recovered in view"
        value={<MoneyValue paise={totals.recoveredPaise} className="text-recovered" />}
        support={`${totals.recoveredCases} cases · ${formatPercent(rate)} of the value in view`}
      />
      <Figure
        label="Stopped"
        value={<span className="tabular">{stopped}</span>}
        support={`${totals.halted} halted by a rule · ${totals.exhausted} out of attempts`}
      />
    </section>
  );
}

/** A share that rounds to nothing is reported as "under 1%", not as zero. */
function share(fraction: number): string {
  if (fraction === 0) return "0%";
  return fraction < 0.01 ? "<1%" : formatPercent(fraction, 0);
}

function Figure({
  label,
  value,
  support,
}: {
  label: string;
  value: ReactNode;
  support: ReactNode;
}) {
  return (
    <div className="px-5 py-3.5">
      <p className="chalk-hand text-[13px] uppercase tracking-[0.08em] text-txt-faint">{label}</p>
      <p className="chalk-strong mt-2 text-[clamp(21px,1.7vw,26px)] font-semibold leading-none tracking-[-0.015em] text-txt">
        {value}
      </p>
      <ChalkRule className="mt-2 w-[58%]" />
      <p className="mt-2 text-[11.5px] leading-[1.45] text-txt-dim">{support}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Export, paging, empty                                               */
/* ------------------------------------------------------------------ */

/**
 * The current view, as a file.
 *
 * Exports the whole filtered set rather than the visible page - an operator
 * asking for a CSV wants the query's answer, not its first forty rows.
 */
function ExportButton({ rows }: { rows: PipelineCase[] }) {
  const download = () => {
    const header = [
      "case_id",
      "type",
      "customer",
      "contact_masked",
      "amount_inr",
      "root_cause",
      "confidence",
      "diagnosis_method",
      "stage",
      "next_action",
      "attempts_used",
      "attempt_cap",
      "recovered_inr",
      "last_activity",
    ];

    const escape = (value: string | number) => {
      const text = String(value);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };

    const body = rows.map((row) =>
      [
        row.id,
        row.type,
        row.customer,
        row.contact,
        row.amountPaise / 100,
        row.rootCause,
        row.confidence ?? "",
        row.method ?? "",
        row.stage.toUpperCase(),
        row.nextAction,
        row.attempts,
        row.attemptCap,
        row.recoveredPaise / 100,
        formatAge(row.updatedMinutesAgo),
      ]
        .map(escape)
        .join(","),
    );

    const blob = new Blob([[header.join(","), ...body].join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `tugboat-pipeline-${rows.length}-cases.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <button type="button" onClick={download} className="btn-op-quiet">
      <DownloadIcon className="h-[13px] w-[13px]" />
      Export CSV
    </button>
  );
}

function Pager({
  start,
  shown,
  total,
  page,
  pages,
  buildHref,
}: {
  start: number;
  shown: number;
  total: number;
  page: number;
  pages: number;
  buildHref: (patch: HrefPatch) => string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
      <p className="mono text-[11.5px] text-txt-faint">
        {start + 1}–{start + shown} of {total}
      </p>

      <div className="flex items-center gap-2">
        <PagerLink href={buildHref({ page: String(page - 1) })} disabled={page <= 1}>
          <ChevronRightIcon className="h-[12px] w-[12px] rotate-180" />
          Previous
        </PagerLink>
        <span className="mono px-1 text-[11.5px] text-txt-dim">
          {page} / {pages}
        </span>
        <PagerLink href={buildHref({ page: String(page + 1) })} disabled={page >= pages}>
          Next
          <ChevronRightIcon className="h-[12px] w-[12px]" />
        </PagerLink>
      </div>
    </div>
  );
}

function PagerLink({
  href,
  disabled,
  children,
}: {
  href: string;
  disabled: boolean;
  children: ReactNode;
}) {
  if (disabled) {
    return (
      <span className="filter-control cursor-default opacity-35" aria-disabled>
        {children}
      </span>
    );
  }
  return (
    <Link href={href} scroll={false} className="filter-control">
      {children}
    </Link>
  );
}

/**
 * Nothing matched.
 *
 * Two readings, and they are not the same thing: an empty batch is good news
 * and gets the radar; an over-narrowed filter is the operator's own doing and
 * gets a way out. Guessing wrong between them is how a product tells someone
 * their revenue is safe when it is only hidden.
 */
function EmptyState({ cleared }: { cleared: string }) {
  return (
    <div className="flex flex-col items-center gap-4 px-6 py-14 text-center">
      <Radar />
      <div>
        <p className="chalk-hand text-[17px] uppercase tracking-[0.06em] text-txt">
          No cases match these filters
        </p>
        <p className="mt-1.5 text-[13px] text-txt-dim">
          Nothing in the batch fits that combination — the agent is still watching everything else.
        </p>
      </div>
      <Link href={cleared} scroll={false} className="btn-op-quiet">
        Clear filters
      </Link>
    </div>
  );
}

/** A sweep, drawn in chalk. Three arcs and a hand - it is a mood, not a chart. */
function Radar() {
  return (
    <svg viewBox="0 0 96 96" className="h-[76px] w-[76px] text-txt-faint" fill="none" aria-hidden>
      <g filter="url(#chalk-tooth)" opacity="0.62">
        <circle cx="48" cy="48" r="34" stroke="currentColor" strokeWidth="1.4" strokeOpacity="0.45" />
        <circle cx="48" cy="48" r="22" stroke="currentColor" strokeWidth="1.4" strokeOpacity="0.6" />
        <circle cx="48" cy="48" r="10" stroke="currentColor" strokeWidth="1.4" strokeOpacity="0.8" />
        <path d="M48 48 24 24" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="66" cy="34" r="2.4" fill="currentColor" />
      </g>
    </svg>
  );
}
