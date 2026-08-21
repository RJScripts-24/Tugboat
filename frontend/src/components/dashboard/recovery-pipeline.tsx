import Link from "next/link";

import { TONE_HEX, type FunnelStage } from "@/lib/dashboard-data";
import { formatRupeesCompact } from "@/lib/money";
import { ChalkNote, ChalkStroke, ChalkTrack } from "./chalk";
import { Section } from "./primitives";

/**
 * The recovery pipeline, drawn on the board (PRD 6.3, page 2).
 *
 * Stroke length tracks rupees, not case count, because the pipeline's job is to
 * show where the *money* stalls - fifty ₹200 checkouts stalling matters less
 * than three ₹40,000 invoices, and a count-based funnel hides exactly that.
 *
 * The stroke is chalk; the length it encodes is exact. Wobble is vertical only,
 * so nothing about the drawing changes what the drawing means. Every stage is
 * still a link into the Pipeline, pre-filtered, and the drawing is inert to the
 * pointer so the whole row stays one click target.
 */
export function RecoveryPipeline({ stages }: { stages: FunnelStage[] }) {
  const widest = Math.max(...stages.map((s) => s.amountPaise));

  // Where the board would get a circle round it: of the stages that really are
  // sequential, the one that loses the most cases. Derived, not authored.
  const worst = stages.reduce<{ key: string; drop: number } | null>((acc, stage, i) => {
    if (i === 0) return acc;
    const previous = stages[i - 1];
    if (stage.cases > previous.cases) return acc;
    const drop = previous.cases - stage.cases;
    return !acc || drop > acc.drop ? { key: stage.key, drop } : acc;
  }, null);

  return (
    <Section title="Recovery pipeline" meta="by value at risk">
      <div className="px-5 pb-4 pt-1">
        {stages.map((stage, i) => {
          const hex = TONE_HEX[stage.tone];
          const previous = i === 0 ? null : stages[i - 1];
          // Only meaningful while each stage is a subset of the one before it.
          const carry =
            previous && stage.cases <= previous.cases
              ? (stage.cases / previous.cases) * 100
              : null;

          return (
            <Link
              key={stage.key}
              href={stage.href}
              className="-mx-2 block rounded-[2px] px-2 py-2 transition-colors hover:bg-[rgba(232,227,214,0.035)]"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="flex items-baseline gap-2.5">
                  <span className="chalk-hand text-[16px] uppercase tracking-[0.07em] text-txt">
                    {stage.label}
                  </span>
                  {worst?.key === stage.key ? (
                    <ChalkNote tone="red">largest drop-off · {worst.drop} cases</ChalkNote>
                  ) : carry !== null ? (
                    <ChalkNote>{carry.toFixed(1)}% carried</ChalkNote>
                  ) : null}
                </span>

                <span className="flex items-baseline gap-3">
                  <span className="mono text-[12px] text-txt-faint">{stage.cases} cases</span>
                  <span className="chalk-strong mono w-[70px] text-right text-[15px] font-medium text-txt">
                    ₹{formatRupeesCompact(stage.amountPaise)}
                  </span>
                </span>
              </div>

              {/* The mark. A dashed groove underneath so a short stroke still
                  reads against the full width it is measured on. */}
              <div className="relative mt-0.5">
                <div className="absolute inset-x-0 top-0">
                  <ChalkTrack height={19} />
                </div>
                <ChalkStroke
                  fraction={stage.amountPaise / widest}
                  color={hex}
                  seed={stage.key}
                  height={19}
                />
              </div>
            </Link>
          );
        })}
      </div>
    </Section>
  );
}
