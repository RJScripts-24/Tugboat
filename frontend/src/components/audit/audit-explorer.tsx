"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { ChalkNote, ChalkRule } from "@/components/dashboard/chalk";
import { LockIcon } from "@/components/dashboard/icons";
import { Section } from "@/components/dashboard/primitives";
import { preciseStampOf } from "@/lib/clock";
import {
  ACTOR_META,
  ACTOR_ORDER,
  type LedgerRow,
  type LedgerSummary,
} from "@/lib/audit-data";
import { chainsOf, verifyChain } from "@/lib/ledger-verify";
import { EMPTY_FILTERS, FilterBar, RANGES, type AuditFilters } from "./filter-bar";
import { LedgerTable } from "./ledger-table";
import { VerifyPanel, type VerifyResult, type VerifyState } from "./verify-panel";

/** Rows rendered at once. The rest arrive a window at a time, when asked for. */
const WINDOW = 60;

/** Chains verified per animation frame, so the bar reports real work. */
const CHAINS_PER_FRAME = 5;

/**
 * Audit Explorer (PRD 6.3, page 8) - the append-only ledger, browsable.
 *
 * Read-only everywhere, by design and not by omission: there is no control on
 * this page that writes, edits, deletes, resolves or annotates a row. The only
 * things a person can do here are narrow the list, look inside a row, copy a
 * digest, verify the chain, and follow a row back to the case it came from.
 *
 * The rows are not fetched. The whole ledger is rendered on the server from
 * `lib/audit-data` and filtered in the browser, because every filter here is a
 * question about a list that is already in memory - and the alternative, a
 * round trip per keystroke, makes the ledger feel heavier the more of it there
 * is. When `GET /audit` lands with real pagination this component keeps its
 * shape; only where `rows` comes from changes.
 */
export function AuditExplorer({
  rows,
  summary,
  index,
  nowMs,
  initialCase,
}: {
  rows: LedgerRow[];
  summary: LedgerSummary;
  index: Record<string, { label: string; cause: string; stage: string }>;
  /** The batch clock's anchor - "now", for the purposes of a time window. */
  nowMs: number;
  /** `?case=C-1042`, so Case Detail and Approvals can point at their own rows. */
  initialCase: string | null;
}) {
  const [filters, setFilters] = useState<AuditFilters>(() =>
    initialCase ? { ...EMPTY_FILTERS, q: initialCase } : EMPTY_FILTERS,
  );
  const [limit, setLimit] = useState(WINDOW);

  const [state, setState] = useState<VerifyState>("idle");
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<VerifyResult | null>(null);
  const frame = useRef<number | null>(null);

  /* ---------------------------------------------------------------- */
  /* Filtering                                                         */
  /* ---------------------------------------------------------------- */

  const filtered = useMemo(() => {
    const term = filters.q.trim().toLowerCase();
    const window = RANGES.find((range) => range.key === filters.range)?.minutes ?? Infinity;
    const floor = window === Number.MAX_SAFE_INTEGER ? -Infinity : nowMs - window * 60_000;

    return rows.filter((row) => {
      if (filters.actor !== "all" && row.actor !== filters.actor) return false;
      if (filters.action !== "all" && row.action !== filters.action) return false;
      if (row.atMs < floor) return false;
      if (filters.maskedOnly && row.masked.length === 0) return false;
      if (term) {
        const hit =
          row.chain.toLowerCase().includes(term) ||
          row.hash.startsWith(term) ||
          row.prevHash.startsWith(term) ||
          row.action.toLowerCase().includes(term) ||
          row.detail.toLowerCase().includes(term);
        if (!hit) return false;
      }
      return true;
    });
  }, [rows, filters, nowMs]);

  // A narrowed list starts at the top again; keeping the old window would show
  // a "load more" button under six rows.
  useEffect(() => setLimit(WINDOW), [filters]);

  const visible = filtered.slice(0, limit);

  /*
   * The window grows only when asked.
   *
   * An observer at the foot was tried and is wrong here: it loads while you
   * scroll, so reaching the end of a filtered view means rendering every row
   * behind it - eighteen hundred table rows, and a page whose own closing
   * section can never be scrolled to because more ledger keeps arriving in
   * front of it. A button is bounded, and it says how much is left.
   */

  /* ---------------------------------------------------------------- */
  /* Verification                                                      */
  /* ---------------------------------------------------------------- */

  // Verification is always over the WHOLE ledger, never the filtered view. A
  // chain is only verifiable end to end, and "the rows you happened to be
  // looking at check out" is not a claim worth making.
  const chains = useMemo(() => chainsOf(rows), [rows]);

  /**
   * The row the tamper demo edits: the middle of the longest case chain, so
   * the cascade behind it is long enough to be worth looking at.
   */
  const target = useMemo(() => {
    let longest: LedgerRow[] | null = null;
    for (const chain of chains) {
      if (chain.chain === "policy") continue;
      if (!longest || chain.rows.length > longest.length) longest = chain.rows;
    }
    return longest ? (longest[Math.floor(longest.length / 3)] ?? null) : null;
  }, [chains]);

  const stop = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);

  useEffect(() => stop, [stop]);

  const run = useCallback(
    (tamperedId: string | null) => {
      stop();
      setState("running");
      setProgress(0);
      setResult(null);

      let i = 0;
      let computeMs = 0;
      let checked = 0;
      const broken: VerifyResult["broken"] = [];

      const step = () => {
        const started = performance.now();
        const end = Math.min(chains.length, i + CHAINS_PER_FRAME);
        for (; i < end; i += 1) {
          checked += chains[i].rows.length;
          broken.push(...verifyChain(chains[i], tamperedId ?? undefined));
        }
        computeMs += performance.now() - started;
        setProgress(i / chains.length);

        if (i < chains.length) {
          frame.current = requestAnimationFrame(step);
          return;
        }

        frame.current = null;
        setResult({
          checked,
          chains: chains.length,
          broken: broken.sort((a, b) => a.chain.localeCompare(b.chain) || a.seq - b.seq),
          computeMs,
          tamperedId,
        });
        setState("done");
      };

      frame.current = requestAnimationFrame(step);
    },
    [chains, stop],
  );

  const brokenById = useMemo(() => {
    const out: Record<string, string> = {};
    for (const row of result?.broken ?? []) out[row.id] = row.reason;
    return out;
  }, [result]);

  /**
   * The tamper demo shows its own cascade, which is no use if the rows are
   * scrolled past or filtered out - so it narrows the list to that chain and
   * says it did.
   */
  const tamper = useCallback(() => {
    if (!target) return;
    setFilters({ ...EMPTY_FILTERS, q: target.chain });
    run(target.id);
  }, [run, target]);

  const restore = useCallback(() => {
    setFilters(EMPTY_FILTERS);
    run(null);
  }, [run]);

  /* ---------------------------------------------------------------- */

  const oldest = preciseStampOf(summary.oldestMs);
  const newest = preciseStampOf(summary.newestMs);
  const tail = preciseStampOf(filtered[filtered.length - 1]?.atMs ?? summary.oldestMs);
  const humanRows = summary.byActor.HUMAN;
  const policyRows = summary.byActor.POLICY;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="mono text-[12px] text-txt-faint">
          seed 42 · {summary.entries.toLocaleString("en-IN")} entries · {summary.chains} chains ·{" "}
          {oldest.day} {oldest.time.slice(0, 5)} → {newest.day} {newest.time.slice(0, 5)} IST
        </p>

        <ChalkNote>
          <LockIcon className="h-[11px] w-[11px]" />
          append-only · nothing on this page can write
        </ChalkNote>
      </div>

      {/* ---------------------------------------------------------- */}
      <section aria-label="Figures for the audit ledger" className="grid grid-cols-2 xl:grid-cols-4">
        <Figure
          label="Entries"
          value={<span className="tabular">{summary.entries.toLocaleString("en-IN")}</span>}
          support={`across ${summary.cases} cases and the policy pack · never updated, only appended`}
        />
        <Figure
          label="Gate decisions"
          value={<span className="tabular">{policyRows.toLocaleString("en-IN")}</span>}
          support="every action checked before it left the building, blocks included"
        />
        <Figure
          label="Written by a human"
          value={<span className="tabular">{humanRows.toLocaleString("en-IN")}</span>}
          support="approvals, rejections, overrides and policy edits — each with a name"
        />
        <Figure
          label="Rows with masked fields"
          value={<span className="tabular">{summary.maskedRows.toLocaleString("en-IN")}</span>}
          support="phone, email and instrument masked before the row was written"
        />
      </section>

      {/* ---------------------------------------------------------- */}
      <VerifyPanel
        state={state}
        progress={progress}
        result={result}
        entries={summary.entries}
        target={target}
        onVerify={() => run(null)}
        onTamper={tamper}
        onRestore={restore}
      />

      {/* ---------------------------------------------------------- */}
      <Section
        title="Ledger"
        action={
          <span className="meta">
            {filtered.length === 0
              ? "no matching entries"
              : `newest first · ${Math.min(limit, filtered.length)} rendered`}
          </span>
        }
        bodyClassName="pb-1"
      >
        <div className="px-5 py-3.5">
          <FilterBar
            filters={filters}
            onChange={setFilters}
            actorCounts={summary.byActor}
            actions={summary.actions}
            total={summary.entries}
            shown={filtered.length}
          />
        </div>

        <ChalkRule />

        {filtered.length === 0 ? (
          <Empty onClear={() => setFilters(EMPTY_FILTERS)} />
        ) : (
          <>
            <LedgerTable
              rows={visible}
              index={index}
              broken={brokenById}
              tamperedId={result?.tamperedId ?? null}
            />

            <div className="px-5 py-4 text-center">
              {limit < filtered.length ? (
                <button
                  type="button"
                  className="btn-op-quiet"
                  onClick={() => setLimit((current) => current + WINDOW)}
                >
                  Show {Math.min(WINDOW, filtered.length - limit)} more ·{" "}
                  {(filtered.length - limit).toLocaleString("en-IN")} left
                </button>
              ) : (
                <p className="mono text-[11px] text-txt-faint">
                  {/* The oldest row *in this view*, not the oldest in the
                      ledger - a filtered list that reports the whole log's
                      floor is reporting a row it is not showing. */}
                  end of the {filtered.length === summary.entries ? "ledger" : "matches"} ·{" "}
                  {filtered.length.toLocaleString("en-IN")} entries, oldest at{" "}
                  {tail.day} {tail.time} IST
                </p>
              )}
            </div>
          </>
        )}
      </Section>

      {/* ---------------------------------------------------------- */}
      <ReadOnlyNote actors={ACTOR_ORDER} />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Empty({ onClear }: { onClear: () => void }) {
  return (
    <div className="px-6 py-10 text-center">
      <p className="chalk-hand text-[16px] uppercase tracking-[0.06em] text-txt">
        Nothing matches that
      </p>
      <p className="mx-auto mt-2 max-w-[460px] text-[12.5px] leading-[1.6] text-txt-dim">
        The ledger is append-only, so an entry that existed is still here — narrow it differently
        rather than assuming it was removed.
      </p>
      <button type="button" className="btn-op-quiet mx-auto mt-4" onClick={onClear}>
        Clear the filters
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Why the page has no buttons that do anything.
 *
 * Worth writing down rather than leaving to be noticed: a reader who does not
 * find an edit control assumes it is on the roadmap. A reader who is told
 * there is deliberately none understands what the log is for.
 */
function ReadOnlyNote({ actors }: { actors: readonly ("BOA" | "POLICY" | "HUMAN" | "SYSTEM")[] }) {
  return (
    <Section title="What is in here, and what cannot be" meta="read-only by design">
      <div className="grid grid-cols-1 gap-x-6 gap-y-4 px-5 pb-4 pt-3.5 xl:grid-cols-2">
        <div>
          <ul className="space-y-2">
            {actors.map((actor) => (
              <li key={actor} className="flex gap-3">
                <span
                  className="mono mt-[3px] w-[52px] shrink-0 text-[10.5px] uppercase tracking-[0.06em]"
                  style={{ color: ACTOR_META[actor].hex }}
                >
                  {actor}
                </span>
                <span className="min-w-0 text-[11.5px] leading-[1.6] text-txt-dim">
                  {ACTOR_META[actor].note}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="space-y-2.5 text-[11.5px] leading-[1.65] text-txt-faint">
          <p>
            There is no edit, no delete, no bulk action and no status a person can set on this page.
            The ledger is written by the gate and the executor as work happens, and read here. A log
            a merchant can change is a log that proves nothing about the merchant.
          </p>
          <p>
            The compliance figures in the{" "}
            <Link href="/simulation" className="text-txt-dim underline-offset-2 hover:text-txt hover:underline">
              Evidence Report
            </Link>{" "}
            are recomputed from these rows rather than reported by the agent — which is the only
            reason they are worth anything. The{" "}
            <Link href="/policies" className="text-txt-dim underline-offset-2 hover:text-txt hover:underline">
              policy pack
            </Link>{" "}
            keeps its revisions in the same ledger, under the chain named{" "}
            <span className="mono text-txt-dim">policy</span>.
          </p>
        </div>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */

/** The console's figure, unchanged from the Control Tower's strip. */
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
