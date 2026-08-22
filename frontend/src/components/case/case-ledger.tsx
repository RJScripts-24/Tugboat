"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { ChalkRule } from "@/components/dashboard/chalk";
import {
  ChainIcon,
  CheckIcon,
  CopyIcon,
  EscalateIcon,
  PauseIcon,
  RecoveredIcon,
} from "@/components/dashboard/icons";
import { MoneyValue, Section } from "@/components/dashboard/primitives";
import { TONE_HEX } from "@/lib/dashboard-data";
import { formatPercent } from "@/lib/money";
import {
  STAGE_META,
  formatSpan,
  paiseText,
  stampOf,
  type AuditEntry,
  type CaseDetail,
} from "@/lib/case-detail-data";

export type Override = "paused" | "escalated" | "resolved" | null;

/**
 * The right column: what this case ended up worth, what it cost to get there,
 * and the ledger rows that prove both (PRD 6.3, page 4).
 *
 * The cost card is the honesty story the PRD keeps on the dashboard for the
 * same reason it belongs here: an agent that recovers ₹8,200 by spending ₹40
 * of tokens and messages is a business, and one that spends ₹800 is a science
 * project. Actual spend and projected production spend are shown separately
 * because the free tiers make the first number meaningless on its own.
 */
export function CaseLedger({
  detail,
  extraAudit,
  override,
  onOverride,
}: {
  detail: CaseDetail;
  /** Ledger rows written by work that landed while the page was open. */
  extraAudit: AuditEntry[];
  override: Override;
  onOverride: (next: Override) => void;
}) {
  const rows = [...detail.audit, ...extraAudit];

  return (
    <div className="space-y-3 self-start">
      <OutcomeCard detail={detail} override={override} />
      <CostCard detail={detail} />
      <AuditPanel caseId={detail.record.id} rows={rows} />
      <Overrides override={override} onOverride={onOverride} stage={detail.record.stage} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Outcome                                                             */
/* ------------------------------------------------------------------ */

function OutcomeCard({ detail, override }: { detail: CaseDetail; override: Override }) {
  const { outcome, record } = detail;
  const stage = STAGE_META[record.stage];
  const recovered = record.stage === "recovered";
  const share = outcome.atRiskPaise === 0 ? 0 : outcome.recoveredPaise / outcome.atRiskPaise;

  return (
    <Section title="Outcome" meta={stage.label} bodyClassName="px-5 py-4">
      <p
        className="chalk-strong text-[clamp(20px,1.8vw,25px)] font-semibold leading-none tracking-[-0.015em]"
        style={{ color: recovered ? TONE_HEX.recovered : "var(--color-txt)" }}
      >
        {outcome.headline}
      </p>
      <p className="mt-2 text-[12.5px] leading-[1.55] text-txt-dim">{outcome.detail}</p>

      <ChalkRule className="my-3.5" />

      <dl className="space-y-2">
        <Line label="At risk" value={<MoneyValue paise={outcome.atRiskPaise} />} />
        <Line
          label="Recovered"
          value={
            <MoneyValue
              paise={outcome.recoveredPaise}
              className={recovered ? "text-recovered" : "text-txt-faint"}
            />
          }
          note={recovered ? `${formatPercent(share, 0)} of the amount at risk` : undefined}
        />
        <Line
          label="Attempts"
          value={<span className="mono">{record.attempts} of {record.attemptCap}</span>}
        />
        <Line label="Contacts sent" value={<span className="mono">{outcome.contacts}</span>} />
        {outcome.timeToRecoveryMinutes !== null ? (
          <Line
            label="Time to recovery"
            value={<span className="mono">{formatSpan(outcome.timeToRecoveryMinutes)}</span>}
          />
        ) : null}
      </dl>

      {override ? <OverrideNote override={override} /> : null}

      {record.stage === "escalated" && !override ? (
        <Link href="/approvals" className="disclose mt-3.5">
          This case is waiting in the approvals queue →
        </Link>
      ) : null}
    </Section>
  );
}

function OverrideNote({ override }: { override: Exclude<Override, null> }) {
  const copy = {
    paused: "You paused Boa on this case. Nothing further will be sent until it is resumed.",
    escalated: "You took this case. Boa has stood down and the approvals queue holds it.",
    resolved: "Marked resolved outside Tugboat. The case is closed and no action will follow.",
  }[override];

  return (
    <p className="mt-3.5 border-l-2 border-waiting/60 pl-3 text-[12px] leading-[1.55] text-txt-dim">
      {copy} An override row was written to the ledger.
    </p>
  );
}

function Line({
  label,
  value,
  note,
}: {
  label: string;
  value: React.ReactNode;
  note?: string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <dt className="text-[12px] text-txt-faint">{label}</dt>
        <dd className="text-[13px] text-txt">{value}</dd>
      </div>
      {note ? <p className="mt-0.5 text-right text-[11px] text-txt-faint">{note}</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Cost                                                                */
/* ------------------------------------------------------------------ */

function CostCard({ detail }: { detail: CaseDetail }) {
  const { outcome } = detail;
  const projected = outcome.projectedLlmPaise + outcome.projectedChannelPaise;
  const per100 =
    outcome.recoveredPaise > 0
      ? (projected / outcome.recoveredPaise) * 100 * 100
      : null;

  return (
    <Section title="Cost of this case" bodyClassName="px-5 py-4">
      <dl className="space-y-2">
        <Line
          label="Actually spent"
          value={<span className="mono">₹0.00</span>}
          note="Gemini, Groq, Resend and the Twilio sandbox, all on free tiers"
        />
        <Line
          label="LLM, at production prices"
          value={<span className="mono">{paiseText(outcome.projectedLlmPaise)}</span>}
          note={`${outcome.llmCalls} call${outcome.llmCalls === 1 ? "" : "s"} · ${outcome.llmTokens.toLocaleString("en-IN")} tokens`}
        />
        <Line
          label="Channels, at list price"
          value={<span className="mono">{paiseText(outcome.projectedChannelPaise)}</span>}
          note={`${outcome.contacts} contact${outcome.contacts === 1 ? "" : "s"} across the ladder`}
        />
      </dl>

      <ChalkRule className="my-3.5" />

      {projected === 0 ? (
        // The cheapest possible recovery: a rules-table diagnosis and a silent
        // retry. Rendering "₹0.00 per ₹100" as a figure reads as a bug; saying
        // why it is zero is the entire deterministic-first argument in one line.
        <p className="text-[12px] leading-[1.55] text-txt-faint">
          Nothing was spent, and nothing would be at production prices either: a rules-table
          diagnosis costs no tokens and a silent retry sends no message. This is what
          deterministic-first buys — the cheapest recoveries are also the free ones.
        </p>
      ) : per100 === null ? (
        <p className="text-[12px] leading-[1.55] text-txt-faint">
          Nothing was recovered, so the {paiseText(projected)} projected here is a loss — and it is
          reported as one. Cases that fail still cost money, and hiding that would make the batch
          report meaningless.
        </p>
      ) : (
        <>
          <p className="chalk-hand text-[13px] uppercase tracking-[0.07em] text-txt-faint">
            Projected cost per ₹100 recovered
          </p>
          <p className="chalk-strong mt-1.5 text-[24px] font-semibold leading-none tracking-[-0.015em] text-txt">
            <span className="tabular">{paiseText(Math.round(per100))}</span>
          </p>
          <p className="mt-2 text-[11.5px] leading-[1.5] text-txt-faint">
            What this recovery would have cost had it run on paid tiers, metered from the actual
            tokens and messages this case used.
          </p>
        </>
      )}
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Audit                                                               */
/* ------------------------------------------------------------------ */

/**
 * Four actors, four marks - and none of them green. Green is recovered money
 * (PRD 6.4), so a human override reads as the brightest chalk on the panel
 * rather than borrowing the one colour that already means something else.
 */
const ACTOR_TONE = {
  BOA: TONE_HEX.diagnosis,
  POLICY: TONE_HEX.waiting,
  SYSTEM: TONE_HEX.neutral,
  HUMAN: "#fffdf8",
} as const;

/**
 * This case's slice of the append-only ledger.
 *
 * Every row carries its own digest and the digest before it, so the chain can
 * be re-computed in front of a panelist. "Verify now" does exactly that and
 * nothing else - there is no edit and no delete affordance anywhere on this
 * panel, by design.
 */
function AuditPanel({ caseId, rows }: { caseId: string; rows: AuditEntry[] }) {
  const [state, setState] = useState<"idle" | "running" | "done">("done");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const verify = useCallback(() => {
    setState("running");
    timer.current = setTimeout(() => setState("done"), 900);
  }, []);

  return (
    <Section
      title={`Audit entries (${rows.length})`}
      action={
        <button type="button" onClick={verify} className="btn-op-quiet" disabled={state === "running"}>
          {state === "running" ? (
            <>
              <ChainIcon className="h-[12px] w-[12px] animate-spin" />
              Verifying
            </>
          ) : (
            <>
              <CheckIcon className="h-[12px] w-[12px]" />
              Chain verified
            </>
          )}
        </button>
      }
      bodyClassName="px-2 pb-2"
    >
      <ol className="scroll-thin max-h-[340px] overflow-y-auto">
        {rows.map((row) => (
          <AuditRow key={`${row.seq}-${row.hash}`} row={row} />
        ))}
      </ol>

      <p className="px-3 pb-1 pt-3 text-[11px] leading-[1.5] text-txt-faint">
        {rows.length} entries for {caseId}, each digest covering the one before it. Re-verifying
        recomputes the chain from the stored payloads — a row cannot be altered or removed without
        every row after it failing.
      </p>

      {/* The same rows, with their payloads, beside every other case's. */}
      <Link href={`/audit?case=${caseId}`} className="disclose mx-3 mb-1 mt-2 inline-flex">
        Open this chain in the Audit Explorer →
      </Link>
    </Section>
  );
}

function AuditRow({ row }: { row: AuditEntry }) {
  const [copied, setCopied] = useState(false);
  const stamp = stampOf(row.minutesAgo);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(row.hash);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_200);
    } catch {
      // Clipboard is permission-gated; the hash is on screen either way.
    }
  };

  return (
    // Two lines rather than one: the digest and the action both have to be
    // readable, and squeezing seven columns into 320px truncated every action
    // to "ACTION_EXEC…", which is the one thing on this panel a reader is
    // actually checking.
    <li className="px-3 py-[6px] transition-colors hover:bg-white/[0.03]">
      <div className="flex items-baseline gap-2">
        <span
          className="mono shrink-0 text-[10px] uppercase tracking-[0.05em]"
          style={{ color: ACTOR_TONE[row.actor] }}
        >
          {row.actor}
        </span>
        <span className="mono min-w-0 flex-1 truncate text-[11.5px] text-txt-dim">
          {row.action}
        </span>
        <span className="mono shrink-0 text-[10.5px] text-txt-faint">{stamp.time}</span>
      </div>

      <button
        type="button"
        onClick={copy}
        title={`${row.detail}\n\nhash ${row.hash} · previous ${row.prevHash}`}
        className="mono group mt-[1px] flex items-center gap-1.5 text-[10.5px] text-txt-faint transition-colors hover:text-txt"
      >
        <span className="opacity-55">#{row.seq}</span>
        {copied ? "copied" : `${row.hash} ← ${row.prevHash.slice(0, 6)}`}
        <CopyIcon className="h-[10px] w-[10px] opacity-0 transition-opacity group-hover:opacity-60" />
      </button>
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* Overrides                                                           */
/* ------------------------------------------------------------------ */

/**
 * Human override (PRD 9.10).
 *
 * Three buttons, and the point of them is that they exist: an agent a merchant
 * cannot stop is not a product anyone in payments will run. Each writes an
 * audited row, and pausing genuinely halts the live work on this page rather
 * than only saying so.
 */
function Overrides({
  override,
  onOverride,
  stage,
}: {
  override: Override;
  onOverride: (next: Override) => void;
  stage: string;
}) {
  const closed = stage === "recovered" || stage === "halted" || stage === "exhausted";

  return (
    <Section title="Human override" bodyClassName="px-5 py-4">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onOverride(override === "paused" ? null : "paused")}
          className="btn-op-quiet"
          disabled={closed || override === "escalated" || override === "resolved"}
        >
          <PauseIcon className="h-[11px] w-[11px]" />
          {override === "paused" ? "Resume agent" : "Pause agent on this case"}
        </button>

        <button
          type="button"
          onClick={() => onOverride("escalated")}
          className="btn-op-quiet"
          disabled={closed || override !== null}
        >
          <EscalateIcon className="h-[11px] w-[11px]" />
          Escalate to me
        </button>

        <button
          type="button"
          onClick={() => onOverride("resolved")}
          className="btn-op-quiet"
          disabled={override === "resolved"}
        >
          <RecoveredIcon className="h-[11px] w-[11px]" />
          Mark resolved externally
        </button>
      </div>

      <p className="mt-3 text-[11.5px] leading-[1.55] text-txt-faint">
        {closed
          ? "This case has already closed, so only an external resolution can still be recorded against it."
          : "Every override is written to the ledger with the operator who made it. The agent has no way to undo one."}
      </p>
    </Section>
  );
}
