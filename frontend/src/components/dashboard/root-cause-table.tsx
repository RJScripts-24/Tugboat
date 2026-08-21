import type { RootCauseRow } from "@/lib/dashboard-data";
import { formatRupeesCompact } from "@/lib/money";
import { ChalkStroke } from "./chalk";
import { Section } from "./primitives";

/**
 * Root-cause breakdown (PRD 6.3, page 2).
 *
 * A table, because that is what this data is. The recovery column carries a
 * single thin bar so the eye can rank six rows without reading six percentages
 * - that is the only visual encoding the section needs.
 *
 * The method column is doing quiet architectural work: it shows which diagnoses
 * came from the rules table and which cost an LLM call, which is the
 * deterministic-first design (ADR-5) made visible on the front page.
 */
export function RootCauseTable({ rows }: { rows: RootCauseRow[] }) {
  const totalCases = rows.reduce((sum, r) => sum + r.cases, 0);

  return (
    <Section title="Root cause" meta={`${totalCases} cases diagnosed`}>
      <div className="scroll-thin overflow-x-auto">
        <table className="optable">
          <thead>
            <tr>
              <th>Cause</th>
              <th className="num">Cases</th>
              <th className="num">Recovered</th>
              <th className="w-[124px]">Recovery</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const total = row.recoveredPaise + row.openPaise;
              const rate = total === 0 ? 0 : (row.recoveredPaise / total) * 100;
              return (
                <tr key={row.code}>
                  <td title={`${row.code} · ₹${formatRupeesCompact(row.openPaise)} still open`}>
                    <span className="text-txt">{row.label}</span>
                    <span
                      className={`mono ml-2 text-[11px] ${
                        row.method === "LLM" ? "text-diagnosis" : "text-txt-faint"
                      }`}
                    >
                      {row.method === "LLM" ? "LLM" : "rules"}
                    </span>
                  </td>
                  <td className="num mono text-txt-dim">{row.cases}</td>
                  <td className="num mono text-recovered">
                    ₹{formatRupeesCompact(row.recoveredPaise)}
                  </td>
                  <td>
                    <span className="flex items-center gap-2.5">
                      <span className="w-[64px] shrink-0">
                        <ChalkStroke
                          fraction={rate / 100}
                          color="var(--color-recovered)"
                          seed={row.code}
                          height={13}
                        />
                      </span>
                      <span className="mono text-[11px] text-txt-dim">{rate.toFixed(0)}%</span>
                    </span>
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
