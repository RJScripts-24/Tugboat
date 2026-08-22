"use client";

import Link from "next/link";

import { ChalkRule } from "@/components/dashboard/chalk";
import { MoneyValue, StatusMark } from "@/components/dashboard/primitives";
import { GATE_META, type ApprovalHistoryRow } from "@/lib/approvals-data";
import { formatLatency, stampOf } from "@/lib/clock";
import { formatPercent } from "@/lib/money";

/** A decided request, including the ones decided in this session. */
export type HistoryRow = ApprovalHistoryRow & { session?: boolean };

/**
 * Everything already answered (PRD 6.3, page 5 - the History tab).
 *
 * The three figures on top are the reason the tab exists: a human in the loop
 * is a latency and a decision quality, and both are measurable. They are
 * computed from the rows underneath rather than passed in, so the KPI and the
 * table can never tell different stories - and they move the moment a decision
 * is taken on the Pending tab, because that decision is one of these rows.
 *
 * Every outcome column is the case's own recovered figure. This page does not
 * get to claim a recovery the pipeline has not recorded.
 */
export function HistoryTable({ rows }: { rows: HistoryRow[] }) {
  const approved = rows.filter((row) => row.decision === "approved");
  const latencies = rows.map((row) => row.latencySeconds).sort((a, b) => a - b);
  const median =
    latencies.length === 0
      ? 0
      : latencies.length % 2 === 1
        ? latencies[(latencies.length - 1) / 2]
        : Math.round((latencies[latencies.length / 2 - 1] + latencies[latencies.length / 2]) / 2);

  // A request approved a minute ago has not had time to recover anything, so
  // it is counted in the decision figures and left out of the outcome one -
  // otherwise every approval taken on stage would visibly drag the rate down
  // while the case it released was still in flight.
  const settled = approved.filter((row) => !row.session);
  const released = settled.reduce((sum, row) => sum + row.atRiskPaise, 0);
  const back = settled.reduce((sum, row) => sum + row.recoveredPaise, 0);
  const givenAway = rows.reduce((sum, row) => sum + row.concessionPaise, 0);
  const inFlight = approved.length - settled.length;

  return (
    <div className="space-y-3">
      <section
        aria-label="Figures for the decisions already taken"
        className="grid grid-cols-2 xl:grid-cols-4"
      >
        <Figure
          label="Median response"
          value={<span className="tabular">{formatLatency(median)}</span>}
          support={`${rows.length} decisions · slowest ${formatLatency(
            latencies[latencies.length - 1] ?? 0,
          )}`}
        />
        <Figure
          label="Approved"
          value={
            <span className="tabular">
              {approved.length}
              <span className="text-txt-faint"> of {rows.length}</span>
            </span>
          }
          support={`${formatPercent(
            rows.length === 0 ? 0 : approved.length / rows.length,
            0,
          )} of requests · ${rows.length - approved.length} refused with a reason`}
        />
        <Figure
          label="Recovered after approval"
          value={<MoneyValue paise={back} className="text-recovered" />}
          support={`${formatPercent(
            released === 0 ? 0 : back / released,
            0,
          )} of the value a yes released · ${settled.filter((r) => r.recoveredPaise > 0).length} cases${
            inFlight > 0 ? ` · ${inFlight} still in flight` : ""
          }`}
        />
        <Figure
          label="Given away"
          value={<MoneyValue paise={givenAway} />}
          support={
            back === 0
              ? "no concession has been approved yet"
              : `${formatPercent(givenAway / back, 1)} of what came back — the cost of saying yes`
          }
        />
      </section>

      <section className="surface">
        <div className="surface-head">
          <h2 className="surface-title">Decisions</h2>
          <span className="meta">newest first · single-tenant demo, one approver</span>
        </div>
        <ChalkRule />

        <div className="scroll-thin overflow-x-auto">
          <table className="optable">
            <thead>
              <tr>
                <th>Decided</th>
                <th>Case</th>
                <th>Gate</th>
                <th>Requested</th>
                <th>Decision</th>
                <th className="num">Response</th>
                <th className="num">At risk</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const stamp = stampOf(row.decidedMinutesAgo);
                const gate = GATE_META[row.gate];
                const approvedRow = row.decision === "approved";

                return (
                  <tr key={row.id} className={row.session ? "row-flash" : undefined}>
                    <td className="mono text-[12px] text-txt-faint">
                      {row.session ? (
                        <span className="text-waiting">this session</span>
                      ) : (
                        <>
                          {stamp.day} · {stamp.time}
                        </>
                      )}
                    </td>
                    <td>
                      <Link
                        href={`/cases/${row.caseId}`}
                        className="mono text-txt underline-offset-4 hover:underline"
                      >
                        {row.caseId}
                      </Link>
                    </td>
                    <td>
                      <StatusMark tone={gate.tone}>{gate.label}</StatusMark>
                    </td>
                    <td
                      className="max-w-[320px] truncate text-txt-faint"
                      title={row.reason ? `${row.headline}\n\nReason: ${row.reason}` : row.headline}
                    >
                      {row.headline}
                    </td>
                    <td className={approvedRow ? "text-txt" : "text-halted"}>
                      {approvedRow ? "Approved" : "Rejected"}
                    </td>
                    <td className="num mono text-txt-faint">
                      {formatLatency(row.latencySeconds)}
                    </td>
                    <td className="num">
                      <MoneyValue paise={row.atRiskPaise} />
                    </td>
                    <td
                      className={
                        row.recoveredPaise > 0 ? "text-recovered" : "text-txt-faint"
                      }
                    >
                      {row.outcome}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <ChalkRule />
        <p className="px-4 py-3 text-[11.5px] leading-[1.55] text-txt-faint sm:px-5">
          Response time is measured from the moment the gate stopped the action to the moment a
          human answered it — the half of the loop the agent does not control, and the one a
          merchant has to staff. Every row here is a case you can open: the same decision is a
          node on its timeline and a{" "}
          <span className="mono">HUMAN · APPROVAL_DECIDED</span> row in its ledger.
        </p>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Figure({
  label,
  value,
  support,
}: {
  label: string;
  value: React.ReactNode;
  support: React.ReactNode;
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
