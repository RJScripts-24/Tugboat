import type { ReactNode } from "react";

import type { Kpis } from "@/lib/dashboard-data";
import { formatPercent } from "@/lib/money";
import { ChalkRule } from "./chalk";
import { CountUpRupees } from "./count-up";
import { MoneyValue } from "./primitives";

/**
 * The financial metrics strip.
 *
 * One row, hairline separators, no cards. Five numbers an operator reads left
 * to right as a sentence: what is bleeding, what came back, how reliably, what
 * is still in flight, and what the recovery cost. The cost figure stays here on
 * the front page rather than in the report - an agent that recovers ₹100 by
 * spending ₹90 is a toy, and hiding that number is how you get away with it.
 */
export function MetricsStrip({ kpis }: { kpis: Kpis }) {
  const inFlight = kpis.activeBreakdown
    .slice(0, 2)
    .map((s) => `${s.count} ${s.label}`)
    .join(" · ");

  return (
    <section
      aria-label="Recovery key figures"
      className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5"
    >
      <Metric
        label="Revenue at risk"
        value={<MoneyValue paise={kpis.revenueAtRiskPaise} />}
        support={`${kpis.revenueAtRiskCases} cases · last 7 days`}
      />

      <Metric
        label="Recovered"
        value={<CountUpRupees paise={kpis.recoveredPaise} className="text-recovered" />}
        support={
          <>
            <span className="text-recovered">+{kpis.upliftPoints} pts</span> vs baseline{" "}
            {formatPercent(kpis.baselineRate)} · {kpis.recoveredCases} cases
          </>
        }
      />

      <Metric
        label="Recovery rate"
        value={<span className="tabular">{formatPercent(kpis.recoveryRate)}</span>}
        support={
          <span className="flex items-center gap-2">
            <Sparkline values={kpis.recoveryRateSeries} />
            <span>14-day trend</span>
          </span>
        }
      />

      <Metric
        label="Active cases"
        value={<span className="tabular">{kpis.activeCases}</span>}
        support={inFlight}
      />

      <Metric
        label="Cost per ₹100 recovered"
        value={<MoneyValue paise={kpis.costPer100Paise} exact />}
        support={`${kpis.llmSharePercent}% inference · ${100 - kpis.llmSharePercent}% channels`}
      />
    </section>
  );
}

function Metric({
  label,
  value,
  support,
}: {
  label: string;
  value: ReactNode;
  support: ReactNode;
}) {
  return (
    <div className="px-5 py-4">
      <p className="chalk-hand text-[13px] uppercase tracking-[0.08em] text-txt-faint">{label}</p>
      <p className="chalk-strong mt-2.5 text-[clamp(25px,2.1vw,31px)] font-semibold leading-none tracking-[-0.015em] text-txt">
        {value}
      </p>
      {/* Underlined the way a figure gets underlined on a board. */}
      <ChalkRule className="mt-2.5 w-[62%]" />
      <p className="mt-2.5 text-[12px] leading-[1.45] text-txt-dim">{support}</p>
    </div>
  );
}

/** Fourteen days of recovery rate, at the size of a word. */
function Sparkline({ values }: { values: number[] }) {
  const w = 62;
  const h = 15;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - ((v - min) / span) * (h - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="chalk-stroke h-[15px] w-[62px] text-txt-dim"
      fill="none"
      aria-hidden
    >
      <g filter="url(#chalk-tooth)">
        <polyline
          points={points}
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
          strokeLinecap="round"
          strokeOpacity="0.75"
        />
      </g>
    </svg>
  );
}
