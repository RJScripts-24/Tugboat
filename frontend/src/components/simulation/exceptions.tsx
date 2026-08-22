import Link from "next/link";

import { ChalkStroke } from "@/components/dashboard/chalk";
import { MoneyValue, Section } from "@/components/dashboard/primitives";
import { CASE_TYPE_META } from "@/lib/pipeline-data";
import { formatPercent, formatRupeesCompact } from "@/lib/money";
import type { ExceptionGroup } from "@/lib/simulation-data";

/**
 * What this batch did not recover, and why (PRD 6.3, page 6 - "do not hide it").
 *
 * The section is deliberately the same weight as the ones above it. A report
 * that puts its failures in a footnote is a report that has decided what it
 * wants the reader to conclude, and Razorpay's own brief asks for the opposite:
 * measured money recovered, with stopping rules and an audit trail, which only
 * means anything if the cases the rules stopped are on the page too.
 *
 * Three of these groups are the agent working correctly. An opt-out, a halt on
 * hostile language and an abstention under the confidence floor are all money
 * left on the table on purpose, and the note on each row says so - not as an
 * excuse, but because "we could have chased this and chose not to" is a
 * different claim from "we tried and failed", and a panelist is entitled to
 * know which one they are looking at.
 */
export function Exceptions({ groups, atRiskPaise }: { groups: ExceptionGroup[]; atRiskPaise: number }) {
  const cases = groups.reduce((sum, group) => sum + group.cases, 0);
  const money = groups.reduce((sum, group) => sum + group.atRiskPaise, 0);
  const widest = Math.max(...groups.map((group) => group.atRiskPaise));

  return (
    <Section
      title="Exceptions"
      meta={`${cases} cases · ₹${formatRupeesCompact(money)} not recovered`}
    >
      <div className="px-5 pb-1 pt-3">
        <p className="max-w-[76ch] text-[12.5px] leading-[1.65] text-txt-dim">
          {formatPercent(money / atRiskPaise)} of the money at risk is in this list. Every case is a
          row you can open — none of these are rounding, and none of them are hidden behind an
          average.
        </p>
      </div>

      <ul className="px-5 pb-4 pt-1">
        {groups.map((group) => (
          <li key={group.key} className="border-b border-white/[0.06] py-3.5 last:border-b-0">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <span className="chalk-hand text-[15.5px] uppercase tracking-[0.06em] text-txt">
                {group.reason}
              </span>
              <span className="flex items-baseline gap-3">
                <span className="mono text-[12px] text-txt-faint">{group.cases} cases</span>
                <span className="chalk-strong mono w-[74px] text-right text-[14px] font-medium text-txt">
                  ₹{formatRupeesCompact(group.atRiskPaise)}
                </span>
              </span>
            </div>

            <div className="mt-1">
              <ChalkStroke
                fraction={group.atRiskPaise / widest}
                color="var(--color-halted)"
                seed={group.key}
                height={14}
              />
            </div>

            <p className="mt-1.5 max-w-[78ch] text-[12px] leading-[1.6] text-txt-dim">
              {group.note}
            </p>

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="meta text-[11px]">largest</span>
              {group.sample.map((row) => (
                <Link key={row.id} href={`/cases/${row.id}`} className="policy-chip">
                  <span className="mono text-txt">{row.id}</span>
                  <span className="text-txt-faint">{CASE_TYPE_META[row.type].short}</span>
                  <MoneyValue paise={row.amountPaise} className="text-txt-dim" />
                </Link>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}
