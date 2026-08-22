import Link from "next/link";

import type { CaseRow } from "@/lib/dashboard-data";
import { MoneyValue, Section, StatusMark } from "./primitives";

/**
 * The working list (PRD 6.3, page 3 - surfaced here as the operational tail of
 * the Control Tower).
 *
 * Everything an operator needs to triage without opening a case: what it is,
 * whose money it is, what Boa concluded and how sure it was, what it is about
 * to do, and how much rope is left against the attempt cap. The attempts column
 * is the bounded-workflow guarantee in its smallest possible form - 3/3 means
 * Boa is finished with that customer whether or not the money came back.
 *
 * Sorting and filtering live on the Pipeline page; this is the top of that list
 * by last activity, and the header links straight through to it.
 */
export function CasesTable({ rows }: { rows: CaseRow[] }) {
  return (
    <Section
      title="Active cases"
      action={
        <Link
          href="/cases"
          className="text-[12px] font-medium text-txt-dim transition-colors hover:text-txt"
        >
          Open pipeline →
        </Link>
      }
    >
      <div className="scroll-thin overflow-x-auto">
        <table className="optable">
          <thead>
            <tr>
              <th>Case</th>
              <th>Customer</th>
              <th className="num">Amount</th>
              <th>Root cause</th>
              <th>Next action</th>
              <th className="num">Attempts</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const capped = row.attempts >= row.attemptCap;
              return (
                <tr key={row.id}>
                  <td>
                    {/* Straight to the case, not to the list with the row
                        picked out. Someone who clicks a case id here wants the
                        case; sending them to the Pipeline first put an
                        unlabelled second click between them and it. */}
                    <Link
                      href={`/cases/${row.id}`}
                      className="mono text-txt underline-offset-2 hover:underline"
                    >
                      {row.id}
                    </Link>
                  </td>
                  <td>
                    <span className="text-txt">{row.customer}</span>
                    <span className="mono ml-2 text-[11px] text-txt-faint">{row.type}</span>
                  </td>
                  <td className="num">
                    <MoneyValue paise={row.amountPaise} className="text-txt" />
                  </td>
                  <td
                    title={`confidence ${row.confidence.toFixed(2)} · ${
                      row.method === "LLM" ? "diagnosed by LLM" : "diagnosed by rules table"
                    }`}
                  >
                    <span className="mono text-[11.5px] text-txt-dim">{row.rootCause}</span>
                    <span
                      className={`mono ml-2 text-[11px] ${
                        row.confidence < 0.6 ? "text-halted" : "text-txt-faint"
                      }`}
                    >
                      {row.confidence.toFixed(2)}
                    </span>
                  </td>
                  <td className="max-w-[210px] truncate text-txt-dim">{row.nextAction}</td>
                  <td className="num">
                    <span className={`mono ${capped ? "text-halted" : "text-txt-dim"}`}>
                      {row.attempts}/{row.attemptCap}
                    </span>
                  </td>
                  <td>
                    <StatusMark tone={row.tone}>{row.status}</StatusMark>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Section>
  );
}
