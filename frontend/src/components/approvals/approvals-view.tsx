"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";

import { ChalkRule } from "@/components/dashboard/chalk";
import { CheckIcon, CloseIcon, EscalateIcon } from "@/components/dashboard/icons";
import { MoneyValue } from "@/components/dashboard/primitives";
import {
  type ApprovalHistoryRow,
  type ApprovalRequest,
  type ApprovalStats,
} from "@/lib/approvals-data";
import { approveRequest, rejectRequest } from "@/lib/actions";
import { formatLatency, formatSpan } from "@/lib/clock";
import { DEMO_MERCHANT } from "@/lib/demo-merchant";
import { formatPercent } from "@/lib/money";
import { useLiveRefresh } from "@/lib/live";
import type { Concern } from "@/lib/socket";
import { HistoryTable, type HistoryRow } from "./history-table";
import { RequestCard, type SessionDecision } from "./request-card";

/** How long a receipt stays on screen. */
const TOAST_MS = 6_000;

type Toast = {
  id: number;
  title: string;
  detail: string;
  tone: "plain" | "halted" | "waiting";
};

type SortKey = "value" | "waiting";

/** The queue moves on its own room; a decision also moves the shell badge. */
const APPROVAL_CONCERNS: Concern[] = ["approvals"];

/**
 * Approvals Queue (PRD 6.3, page 5) - compliant escalation, made visible.
 *
 * The page exists to be unimpressive in the right way: these are the things
 * the agent planned, checked, and then refused to do on its own. Every card is
 * a case that is genuinely sitting in `escalated` in the pipeline, with the
 * money it is holding, the rule that stopped it, and the exact message that
 * would go out if you say yes.
 *
 * Decisions go to `POST /approvals/:id/approve|reject` and nothing about them
 * is decided here. That is the Stage 9 change worth reading: this component
 * used to hold the decision itself and write a ledger row for it in the
 * browser, because there was nothing else to hold it. Approving is now a
 * *permission* rather than a send — the gate runs again on the release, and a
 * customer who opted out in the meantime still halts a message a merchant
 * already said yes to (D-67). So the toast says "released", not "sent", because
 * that is what actually happened.
 *
 * The receipt on the card is optimistic and the row underneath it is not: the
 * action revalidates this page, so within a moment the History tab is showing
 * the decision as the API recorded it rather than as this component described
 * it.
 */
export function ApprovalsView({
  pending,
  history,
  stats,
}: {
  pending: ApprovalRequest[];
  history: ApprovalHistoryRow[];
  stats: ApprovalStats;
}) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();

  // Decision buttons stay disabled until React has hydrated: a click before the
  // handlers attach dies silently, and on this page that reads as a decision
  // that was swallowed (same guard as the Case Detail overrides).
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  // A case escalating while you watch: `approval.pending` arrives on the
  // approvals room and the page re-reads the queue. The seeded version of this
  // was a `setTimeout` that revealed one hand-picked request nine seconds in.
  useLiveRefresh(
    useCallback(() => router.refresh(), [router]),
    APPROVAL_CONCERNS,
  );

  const [tab, setTab] = useState<"pending" | "history">("pending");
  const [sort, setSort] = useState<SortKey>("value");
  const [decisions, setDecisions] = useState<Record<string, SessionDecision>>({});
  const [edits, setEdits] = useState<Record<string, string[]>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextToast = useRef(0);

  const pushToast = useCallback((toast: Omit<Toast, "id">) => {
    const id = (nextToast.current += 1);
    setToasts((current) => [...current, { ...toast, id }]);
    setTimeout(() => setToasts((current) => current.filter((row) => row.id !== id)), TOAST_MS);
  }, []);

  const requests = useMemo(() => {
    return [...pending].sort((a, b) =>
      sort === "value"
        ? b.atRiskPaise - a.atRiskPaise
        : b.requestedMinutesAgo - a.requestedMinutesAgo,
    );
  }, [pending, sort]);

  const open = requests.filter((request) => !decisions[request.id]);

  /**
   * Answer one request.
   *
   * The receipt on the card is written immediately and the truth arrives a
   * moment later: the server action revalidates this page, so the History tab
   * ends up showing the decision as the API recorded it — with the latency it
   * actually measured — rather than as this component described it.
   *
   * The approval toast says "released", not "sent". That is not hedging: the
   * gate runs again when the release job fires, and it can still defer the
   * message into tomorrow morning or refuse it outright if the customer opted
   * out while the request was waiting (D-67). A toast claiming the message went
   * would be the one sentence on this page that the product cannot back up.
   */
  const decide = useCallback(
    (
      request: ApprovalRequest,
      verdict: "approved" | "rejected",
      reason: string | null,
      edited: boolean,
      /** A yes that also puts the case back to attempt zero (D-157). */
      restart = false,
    ) => {
      const at = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Kolkata",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }).format(new Date());

      setDecisions((current) => ({
        ...current,
        [request.id]: { verdict, reason, at, edited, restarted: restart },
      }));

      startTransition(async () => {
        const result =
          verdict === "approved"
            ? await approveRequest(
                request.id,
                {
                  // The edited body, when the approver rewrote it. The API
                  // restores the opt-out line if the edit removed it, rather
                  // than refusing the edit (D-68).
                  lines: edited ? edits[request.id] : undefined,
                  subject: request.draft.subject,
                },
                { restart },
              )
            : await rejectRequest(request.id, reason ?? "No reason given");

        if (!result.ok) {
          // The card goes back to undecided: a receipt for something that did
          // not happen is worse than no receipt.
          setDecisions((current) => {
            const next = { ...current };
            delete next[request.id];
            return next;
          });

          pushToast({
            title: `Could not record the decision on ${request.caseId}`,
            detail: result.error,
            tone: "halted",
          });
          return;
        }

        pushToast(
          verdict === "approved"
            ? {
                title: `${restart ? "Restarted" : "Approved"} \u00b7 ${request.caseId}`,
                detail: restart
                  ? `Attempts back to 0 of ${request.attemptCap} and the channel caps counted from now \u2014 the gate still re-runs before anything is sent, and an opt-out would still stop it`
                  : "Released to the executor \u2014 the gate re-runs before anything is sent, and the decision is on the case's ledger chain",
                tone: "plain",
              }
            : {
                title: `Rejected \u00b7 ${request.caseId}`,
                detail: `${reason} \u2014 Boa stays stood down and the reason is on the ledger`,
                tone: "halted",
              },
        );
      });
    },
    [edits, pushToast],
  );

  /** Session decisions, shaped as history rows so one table renders both. */
  const sessionRows: HistoryRow[] = useMemo(
    () =>
      requests
        .filter((request) => decisions[request.id])
        .map((request) => {
          const decision = decisions[request.id];
          const approved = decision.verdict === "approved";
          return {
            id: request.id,
            caseId: request.caseId,
            gate: request.gate,
            decision: decision.verdict,
            decidedBy: DEMO_MERCHANT.displayName,
            afterAttempt: request.attempts,
            headline: request.headline,
            reason: decision.reason,
            requestedMinutesAgo: request.requestedMinutesAgo,
            decidedMinutesAgo: 0,
            // The honest response time for a request you just answered is how
            // long it had been waiting, not how long the click took.
            latencySeconds: Math.max(1, Math.round(request.requestedMinutesAgo * 60)),
            customer: request.customer,
            caseType: request.caseType,
            stage: "escalated" as const,
            atRiskPaise: request.atRiskPaise,
            recoveredPaise: 0,
            concessionPaise: approved ? request.concessionPaise : 0,
            outcome: approved
              ? "Case resumed · outcome still in flight"
              : "Agent stood down · no further contact",
            session: true,
          };
        }),
    [requests, decisions],
  );

  const rows = [...sessionRows, ...history];
  const heldPaise = open.reduce((sum, request) => sum + request.atRiskPaise, 0);
  const concessions = open.filter((request) => request.concessionPaise > 0);
  const oldest = open.reduce((max, request) => Math.max(max, request.requestedMinutesAgo), 0);
  const medianSeconds = rows.length === 0 ? stats.medianLatencySeconds : medianOf(rows);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="mono text-[12px] text-txt-faint">
          {/* Was "seed 42 … policy v4": one literal over a live queue that has
              no seed, and another that disagreed with the top bar the moment
              anybody saved a pack. */}
          {open.length} waiting · ₹{plain(heldPaise)} held · median response{" "}
          {formatLatency(medianSeconds)}
        </p>

        {tab === "pending" && open.length > 1 ? (
          <div className="flex items-center gap-2">
            <span className="meta hidden sm:inline">Order by</span>
            <button
              type="button"
              className="filter-control"
              data-active={sort === "value"}
              onClick={() => setSort("value")}
            >
              Money at risk
            </button>
            <button
              type="button"
              className="filter-control"
              data-active={sort === "waiting"}
              onClick={() => setSort("waiting")}
            >
              Longest waiting
            </button>
          </div>
        ) : null}
      </div>

      {/* The queue's own figures, on the queue's own tab: History carries its
          latency and outcome KPIs, and two strips of four would just be eight
          numbers competing for the same glance. Rendered conditionally rather
          than hidden - `display: grid` beats the `[hidden]` rule, so the
          attribute alone would hide nothing. */}
      {tab === "pending" ? (
        <section
          aria-label="Figures for the approvals queue"
          className="grid grid-cols-2 xl:grid-cols-4"
        >
          <Figure
            label="Waiting on you"
            value={<span className="tabular">{open.length}</span>}
            support={
              open.length === 0
                ? "the queue is clear — Boa is inside its bounds"
                : `oldest has waited ${formatSpan(oldest)} · Boa is paused on each one`
            }
          />
          <Figure
            label="Value held"
            value={<MoneyValue paise={heldPaise} />}
            support={`across ${open.length} case${
              open.length === 1 ? "" : "s"
            } · nothing moves on them until you decide`}
          />
          <Figure
            label="Concessions asked for"
            value={
              <MoneyValue
                paise={concessions.reduce((sum, request) => sum + request.concessionPaise, 0)}
              />
            }
            support={`${concessions.length} of ${open.length} request${
              open.length === 1 ? "" : "s"
            } asks to give money away`}
          />
          <Figure
            label="Median response"
            value={<span className="tabular">{formatLatency(medianSeconds)}</span>}
            support={`over ${rows.length} decisions · ${formatPercent(
              rows.length === 0
                ? 0
                : rows.filter((row) => row.decision === "approved").length / rows.length,
              0,
            )} approved`}
          />
        </section>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="filter-control"
          data-active={tab === "pending"}
          onClick={() => setTab("pending")}
        >
          <EscalateIcon className="h-[12px] w-[12px]" />
          Pending ({open.length})
        </button>
        <button
          type="button"
          className="filter-control"
          data-active={tab === "history"}
          onClick={() => setTab("history")}
        >
          <CheckIcon className="h-[12px] w-[12px]" />
          History ({rows.length})
        </button>

        <span className="meta ml-auto hidden sm:inline">
          {tab === "pending"
            ? "every card is an action the gate refused to let Boa take alone"
            : "every row is a case you can open and check"}
        </span>
      </div>

      {tab === "pending" ? (
        requests.length === 0 ? (
          <Empty />
        ) : (
          <ol className="space-y-3">
            {requests.map((request) => (
              <li key={request.id}>
                <RequestCard
                  request={request}
                  busy={busy || !ready}
                  // Highlights a request that arrived in the last minute:
                  // whatever escalated while somebody was looking at the page.
                  live={request.requestedMinutesAgo < 1}
                  decision={decisions[request.id] ?? null}
                  draftLines={edits[request.id] ?? request.draft.lines}
                  onApprove={(edited) => decide(request, "approved", null, edited)}
                  onRestart={(edited) => decide(request, "approved", null, edited, true)}
                  onReject={(reason) => decide(request, "rejected", reason, false)}
                  onEditDraft={(lines) =>
                    setEdits((current) => {
                      const next = { ...current };
                      if (lines === null) delete next[request.id];
                      else next[request.id] = lines;
                      return next;
                    })
                  }
                />
              </li>
            ))}
          </ol>
        )
      ) : (
        <HistoryTable rows={rows} />
      )}

      {open.length === 0 && requests.length > 0 && tab === "pending" ? <Cleared /> : null}

      <div className="toast-stack" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className="toast">
            <p className="flex items-center gap-2 text-[12.5px] font-medium text-txt">
              {toast.tone === "halted" ? (
                <CloseIcon className="h-[12px] w-[12px] text-halted" />
              ) : toast.tone === "waiting" ? (
                <EscalateIcon className="h-[12px] w-[12px] text-waiting" />
              ) : (
                <CheckIcon className="h-[12px] w-[12px] text-txt" />
              )}
              {toast.title}
            </p>
            <p className="mt-1 text-[11.5px] leading-[1.5] text-txt-faint">{toast.detail}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function medianOf(rows: HistoryRow[]): number {
  const values = rows.map((row) => row.latencySeconds).sort((a, b) => a - b);
  if (values.length === 0) return 0;
  return values.length % 2 === 1
    ? values[(values.length - 1) / 2]
    : Math.round((values[values.length / 2 - 1] + values[values.length / 2]) / 2);
}

function plain(paise: number): string {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(
    Math.round(paise / 100),
  );
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

/** Nothing has ever been escalated - the honest version of a blank table. */
function Empty() {
  return (
    <section className="surface px-6 py-10 text-center">
      <p className="chalk-hand text-[17px] uppercase tracking-[0.06em] text-txt">
        Nothing is waiting on you
      </p>
      <p className="mx-auto mt-2 max-w-[440px] text-[12.5px] leading-[1.6] text-txt-dim">
        Every case is inside the bounds Boa is allowed to work in. A discount, a high-value
        receivable, a hardship reply or a diagnosis under the floor would land here — and so does
        any case a person takes, or one the agent stops on without a rule of its own to quote.
      </p>
      <Link href="/policies" className="disclose mt-4 inline-flex">
        See which gates would stop it →
      </Link>
    </section>
  );
}

/** Everything on screen has been answered in this session. */
function Cleared() {
  return (
    <section className="surface px-6 py-5 text-center">
      <p className="chalk-hand text-[15px] uppercase tracking-[0.06em] text-txt">Queue cleared</p>
      <p className="mx-auto mt-1.5 max-w-[520px] text-[12px] leading-[1.6] text-txt-dim">
        Every request has an answer and a reason against it. The cases you released are back with
        Boa inside the same caps they had before — approving does not widen a bound, it only
        unblocks the one action you read. A restart is the one exception, and it says so on the
        card and on the case&rsquo;s own timeline.
      </p>
    </section>
  );
}
