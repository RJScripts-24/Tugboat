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
  PhoneIcon,
  RecoveredIcon,
} from "@/components/dashboard/icons";
import { MoneyValue, Section } from "@/components/dashboard/primitives";
import { TONE_HEX } from "@/lib/dashboard-data";
import { formatPercent } from "@/lib/money";
import { formatSpan, stampOf } from "@/lib/clock";
import {
  STAGE_META,
  paiseText,
  type AuditEntry,
  type CaseDetail,
} from "@/lib/case-detail-data";
import type { CaseState, OverrideKind } from "@/lib/event-store";
import { verifyRow } from "@/lib/ledger-verify";

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
  state,
  onOverride,
  onRequestCall,
  paused,
  busy = false,
}: {
  detail: CaseDetail;
  /**
   * Folded from the case's own ledger chain: which override came last, how many
   * are on it, whether the case was settled outside Tugboat. Not whether it is
   * on hold — that is `paused`, and the difference is B-82.
   */
  state: CaseState;
  /** `cases.pausedAt` is set: the column the PolicyGate actually enforces. */
  paused: boolean;
  onOverride: (kind: OverrideKind) => void;
  /** Asks the gate what would stop a call, then rings or opens the dialog. */
  onRequestCall: () => void;
  /** An override is in flight — the buttons say so rather than firing twice. */
  busy?: boolean;
}) {
  // One list, straight off the response. This used to be the server's rows plus
  // whatever the browser had appended since; there is nothing to append now.
  const rows = detail.audit;

  return (
    <div className="space-y-3 self-start">
      <OutcomeCard detail={detail} state={state} paused={paused} />
      <CostCard detail={detail} />
      <AuditPanel caseId={detail.record.id} rows={rows} />
      <Overrides
        state={state}
        onOverride={onOverride}
        onRequestCall={onRequestCall}
        stage={detail.record.stage}
        openApprovals={detail.record.openApprovals}
        paused={paused}
        attempts={detail.record.attempts}
        attemptCap={detail.record.attemptCap}
        busy={busy}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Outcome                                                             */
/* ------------------------------------------------------------------ */

function OutcomeCard({
  detail,
  state,
  paused,
}: {
  detail: CaseDetail;
  state: CaseState;
  paused: boolean;
}) {
  const { outcome, record } = detail;
  const recovered = record.stage === "recovered";
  const share = outcome.atRiskPaise === 0 ? 0 : outcome.recoveredPaise / outcome.atRiskPaise;

  /*
   * Held by a human, and stood down: read from the server, not from the fold.
   *
   * `caseStateOf` is still what tells this card the *story* — which override
   * came last, how many are on the chain, whether the case was settled
   * elsewhere. What it must not decide any more is whether the case is on hold
   * right now, because a fold is only as current as the rows it has. An
   * approved handover clears `pausedAt` in the database, and until D-159 wrote
   * a row saying so the browser went on reporting a hold the gate was no longer
   * applying: this card read "Handed to you · Boa has stood down" over a case
   * the agent was working, and the override buttons offered acts the API
   * answers with 400 (B-82). `record.stage` and `pausedAt` are the two columns
   * the API's own guards read. Reading them here is what keeps the page's
   * offer and the API's answer the same sentence.
   */
  const takenByHuman = record.stage === "escalated";

  /*
   * Held by a human *and* actually asked something.
   *
   * The two are not the same, which is what the link below got wrong. A case
   * stays `escalated` after its request is answered — the release can fail, a
   * promise can break, a reply can come back angry — so "waiting in the
   * approvals queue" was printed over a queue that held nothing, on the one
   * page whose job is to be the truthful account of a case (B-88).
   */
  const askedOfYou = takenByHuman && record.openApprovals > 0;

  /*
   * An override changes the outcome, not just the note underneath it.
   *
   * The card used to render the seeded stage whatever had happened, so a case
   * marked resolved outside Tugboat still read "Committed · ₹18,400 still in
   * flight" - the single most damaging thing this page could say, because the
   * page exists to be the truthful account of one case.
   */
  const stageLabel = state.resolvedExternally
    ? "Closed externally"
    : takenByHuman
      ? "With you"
      : paused
        ? "Paused"
        : STAGE_META[record.stage].label;

  const headline = state.resolvedExternally
    ? "Resolved outside Tugboat"
    : takenByHuman
      ? "Handed to you"
      : paused
        ? "Paused by you"
        : outcome.headline;

  const detailLine = state.resolvedExternally
    ? "Closed by a human, not by the agent. Nothing further will be attempted and no money is counted as recovered here."
    : askedOfYou
      ? "Boa has stood down. The case is yours until you release it."
      : takenByHuman
      ? "Boa has stood down and there is no open request. The case is yours until you release it."
      : paused
        ? "Boa is stood down on this case. Scheduled work will not run until you resume it."
        : outcome.detail;

  return (
    <Section title="Outcome" meta={stageLabel} bodyClassName="px-5 py-4">
      <p
        className="chalk-strong text-[clamp(20px,1.8vw,25px)] font-semibold leading-none tracking-[-0.015em]"
        style={{
          color: recovered && !state.resolvedExternally ? TONE_HEX.recovered : "var(--color-txt)",
        }}
      >
        {headline}
      </p>
      <p className="mt-2 text-[12.5px] leading-[1.55] text-txt-dim">{detailLine}</p>

      <ChalkRule className="my-3.5" />

      <dl className="space-y-2">
        <Line label="At risk" value={<MoneyValue paise={outcome.atRiskPaise} />} />
        <Line
          label="Recovered"
          value={
            <MoneyValue
              paise={outcome.recoveredPaise}
              className={recovered && !state.resolvedExternally ? "text-recovered" : "text-txt-faint"}
            />
          }
          note={
            state.resolvedExternally
              ? "settled elsewhere · not counted as agent recovery"
              : recovered
                ? `${formatPercent(share, 0)} of the amount at risk`
                : undefined
          }
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

      {state.last ? (
        <OverrideNote
          last={state.last}
          appended={state.appended}
          stillHeld={takenByHuman}
          askedOfYou={askedOfYou}
        />
      ) : null}

      {/* Whoever put it there. Taking a case used to hide this link — the note
          above said the queue held the case and gave you no way to reach it,
          on the one page where the question "so what happens now?" is asked
          (D-151). Every escalated case has a card now, so every escalated case
          gets the link. */}
      {askedOfYou ? (
        <Link href="/approvals" className="disclose mt-3.5">
          {state.last === "escalate"
            ? "Answer it in the approvals queue →"
            : "This case is waiting in the approvals queue →"}
        </Link>
      ) : null}
    </Section>
  );
}

/**
 * The last override, in a sentence — and only the part of it that is still true.
 *
 * The fold names the last override correctly for as long as the chain is read
 * forwards, and then keeps saying it. A case taken and handed back still has
 * `escalate` as its last override row, so this note went on announcing a
 * question the merchant had already answered (B-82). The row is history and
 * stays; the clause about what happens next is checked against the case.
 */
function OverrideNote({
  last,
  appended,
  stillHeld,
  askedOfYou,
}: {
  last: OverrideKind;
  appended: number;
  /** The case is escalated *now*, not merely was. */
  stillHeld: boolean;
  /** And there is a card in the queue about it — the narrower of the two (B-88). */
  askedOfYou: boolean;
}) {
  const copy = {
    pause: "You paused Boa on this case. Nothing further will be sent until it is resumed.",
    resume: "You resumed Boa. The pause is still on the ledger — it was appended over, not undone.",
    escalate: askedOfYou
      ? "You took this case. Boa has stood down, and the approvals queue is now asking you whether it should carry on or close the case."
      : stillHeld
        ? "You took this case. Boa has stood down and the request has been answered, so nothing is waiting in the queue — the case is yours until you release it."
        : "You took this case and it has since been handed back to Boa. The row is still on the ledger — appended over, not undone.",
    resolve: "Marked resolved outside Tugboat. The case is closed and no action will follow.",
    call: "You asked Boa to call. The gate answers first — quiet hours, opt-out and the one-call cap — and the call goes out at the next moment it allows.",
  }[last];

  return (
    <p className="mt-3.5 border-l-2 border-waiting/60 pl-3 text-[12px] leading-[1.55] text-txt-dim">
      {copy}{" "}
      {appended === 1
        ? "One row was appended to this case's chain."
        : `${appended} rows have been appended to this case's chain this session.`}
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
          value={<span className="mono">{paiseText(outcome.spentPaise)}</span>}
          note="Metered from this case rather than assumed — Groq, Resend and the Twilio sandbox bill nothing, a real send does"
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
  const [state, setState] = useState<"idle" | "running" | "checked" | "broken">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  // A new chain is an unanswered question again.
  useEffect(() => setState("idle"), [rows]);

  /*
   * This was a 900ms timer that flipped the label to "Chain verified", on a
   * panel whose own caption explains that re-verifying recomputes the chain
   * from the stored payloads. It could not have done that: the rows it is
   * handed carried no digest preimage (B-81). They carry one now, and this
   * recomputes every digest with the same function the Audit Explorer uses,
   * then checks each row links to the one before it.
   */
  const verify = useCallback(() => {
    setState("running");
    // One frame, so the spinner paints before the hashing blocks the thread.
    timer.current = setTimeout(() => {
      let previous: string | null = null;
      const ok = rows.every((row) => {
        const linked = previous === null || row.prevHash === previous;
        previous = row.hash;
        return verifyRow(row).matches && linked;
      });
      setState(ok ? "checked" : "broken");
    }, 16);
  }, [rows]);

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
          ) : state === "checked" ? (
            <>
              <CheckIcon className="h-[12px] w-[12px]" />
              Chain verified
            </>
          ) : state === "broken" ? (
            <>
              <ChainIcon className="h-[12px] w-[12px]" />
              Chain broken
            </>
          ) : (
            <>
              <ChainIcon className="h-[12px] w-[12px]" />
              Verify chain
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
  state,
  onOverride,
  onRequestCall,
  stage,
  openApprovals,
  paused,
  attempts,
  attemptCap,
  busy,
}: {
  state: CaseState;
  onOverride: (kind: OverrideKind) => void;
  onRequestCall: () => void;
  stage: string;
  /** Requests still open on this case — see `alreadyYours` (B-88). */
  openApprovals: number;
  paused: boolean;
  attempts: number;
  attemptCap: number;
  busy: boolean;
}) {
  // Until React has hydrated, these buttons have no click handler: a click in
  // that window dies with no request, no error and no feedback, which reads as
  // "the button is broken". Rendered disabled on the server and enabled on
  // mount, the not-ready state is visible instead of silent.
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  // A recovered case is finished and the API refuses to override one, so the
  // button is disabled rather than offered and then rejected. Halted and
  // exhausted cases stay closed here for the same reason they did before.
  const closed = stage === "recovered" || stage === "halted" || stage === "exhausted";
  // Resolving externally is terminal. Everything else stays available, because
  // an append-only log has no reason to forbid a second pause - it just
  // records one.
  const done = state.resolvedExternally;
  const waiting = busy || !ready;

  /*
   * A case that ran out of attempts can still be taken by a person (D-150).
   * The agent is finished with it either way — nothing reschedules, and the
   * gate still counts attempts against the pack — but "the agent gave up" and
   * "nobody can pick this up" are different sentences, and only the first one
   * is true.
   *
   * `halted` is included as of B-86. It is not only where an opt-out lands: a
   * delivery that would not go through, a gate with no channel left to try, and
   * a case somebody settled elsewhere all end there too, and none of those is a
   * customer withdrawing consent. The API refuses the one case that is — a
   * halted case whose customer replied STOP — and says so, which is a better
   * answer than a button that was never offered.
   */
  const canEscalate = !done && stage !== "escalated" && stage !== "recovered";

  /*
   * A case you already took is not a dead button, it is a link (B-80).
   *
   * "Escalate to me" disables itself once the chain shows the case is yours,
   * which is correct and reads exactly like the failure it is not: the click
   * does nothing, the tooltip needs a hover to find, and the case is in fact
   * waiting for you one page away. Where the button would be dead there is
   * somewhere to go instead.
   *
   * Only when the card is genuinely open, though. An escalated case whose
   * request has been answered — a release that failed to send, a promise that
   * broke — has nowhere for this link to lead, and sending somebody to an empty
   * queue is the same broken promise the link was written to remove (B-88).
   */
  const alreadyYours = stage === "escalated" && !done && openApprovals > 0;

  /*
   * A case with no attempts left has nothing to call with (B-82).
   *
   * "Ask Boa to call now" was offered on a `waiting` case whose fourth of four
   * attempts was already spent. The click was honest all the way down — the
   * override wrote its row, the planner drew a voice rung, the gate refused it
   * on the attempt cap — and the visible result was that asking for a call
   * exhausted the case instead of placing one. The bound is on the same page,
   * two panels up ("Attempts · 4 of 4"); the button is the last surface that
   * should have to be told.
   */
  const spent = attempts >= attemptCap;

  // Why each button is off, in the words the tooltip will use. A disabled
  // control that does not say why is the same dead end as one that silently
  // does nothing (B-73) — the click just fails earlier.
  const reason = (blocked: boolean, why: string): string | undefined =>
    !ready ? "Just a moment — the page is still loading" : blocked ? why : undefined;

  const closedWhy =
    stage === "recovered"
      ? "This case is recovered — there is nothing left to take over"
      : stage === "exhausted"
        ? "The agent stopped at its attempt cap. Raise the cap in Policies if it should keep going"
        : "This case was halted by a stopping rule";

  return (
    <Section title="Human override" bodyClassName="px-5 py-4">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onOverride(paused ? "resume" : "pause")}
          className="btn-op-quiet"
          // Off on a closed case, paused or not. B-86 kept "Resume agent" live
          // on a paused case that had since halted so the hold could be
          // cleared — but clearing it moved nothing, because the machine has no
          // way out of `halted` or `exhausted` except a human taking the case,
          // and the click read as a resume that did nothing (B-89). Closes now
          // drop the hold themselves, and the way back is named below.
          disabled={waiting || done || closed}
          title={reason(
            closed || done,
            done
              ? "This case was closed outside Tugboat"
              : stage === "recovered"
                ? closedWhy
                : `${closedWhy}. The agent is closed to it — use "Escalate to me" and approve the handover with a restart to reopen it`,
          )}
        >
          <PauseIcon className="h-[11px] w-[11px]" />
          {paused ? "Resume agent" : "Pause agent on this case"}
        </button>

        {alreadyYours ? (
          <Link href="/approvals" className="btn-op-quiet">
            <EscalateIcon className="h-[11px] w-[11px]" />
            This case is yours · answer it in Approvals
          </Link>
        ) : (
          <button
            type="button"
            onClick={() => onOverride("escalate")}
            className="btn-op-quiet"
            disabled={waiting || !canEscalate}
            title={reason(
              !canEscalate,
              done
                ? "This case was closed outside Tugboat"
                : stage === "escalated"
                  ? "You already have this case · no request is open on it"
                  : closedWhy,
            )}
          >
            <EscalateIcon className="h-[11px] w-[11px]" />
            Escalate to me
          </button>
        )}

        <button
          type="button"
          // Not `onOverride("call")` any more: the gate is asked first, and a
          // cool-down is something the merchant can choose to spend (D-160).
          onClick={onRequestCall}
          className="btn-op-quiet"
          disabled={waiting || closed || done || paused || spent}
          title={reason(
            closed || done || paused || spent,
            done
              ? "This case was closed outside Tugboat"
              : closed
                ? closedWhy
                : paused
                  ? "Boa is paused on this case — resume it first"
                  : `All ${attemptCap} attempts are used, so the gate would refuse the call. Raise the cap in Policies if this case should keep going`,
          )}
        >
          <PhoneIcon className="h-[11px] w-[11px]" />
          Ask Boa to call now
        </button>

        <button
          type="button"
          onClick={() => onOverride("resolve")}
          className="btn-op-quiet"
          disabled={waiting || done}
          title={reason(done, "This case was already closed outside Tugboat")}
        >
          <RecoveredIcon className="h-[11px] w-[11px]" />
          Mark resolved externally
        </button>
      </div>

      <p className="mt-3 text-[11.5px] leading-[1.55] text-txt-faint">
        {done
          ? "This case was closed outside Tugboat. Its chain stays open to read and is closed to writes."
          : stage === "exhausted"
            ? "Boa stopped here because it reached its attempt cap, not because it ran out of ideas. It will send nothing further — but you can take the case yourself, or raise the cap in Policies and let it keep going."
            : closed
              ? "This case has already closed, so only an external resolution can still be recorded against it."
              : "Every override appends a row to this case's chain, with the operator who made it. Resuming appends a resume — nothing here can unwrite what is already on the ledger."}
      </p>
    </Section>
  );
}
