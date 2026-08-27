import type { SuccessRateSeries } from "@/lib/dashboard-data";
import { ChalkNote } from "./chalk";
import { Section } from "./primitives";

/**
 * Payment performance (PRD 6.3, page 2 · detector in 7.7).
 *
 * A monitoring panel: the trailing baseline as a dashed rule, the window that
 * fell through it shaded, and a readout row underneath. The alert line is red
 * because something was actually wrong, which is the only reason anything on
 * this page is allowed to be red.
 *
 * The point worth making while this is on screen is what Boa did *not* do: a
 * gateway outage is the merchant's problem, not the customer's, so those 47
 * cases were queued for a silent retry rather than blasted with nudges.
 *
 * Hand-drawn SVG rather than a charting library - one chart does not justify
 * the bundle, and this way the geometry matches the rest of the console.
 */

const W = 720;
const H = 168;
const PAD = { top: 12, right: 12, bottom: 22, left: 30 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;
const Y_MIN = 55;
const Y_MAX = 100;

const x = (i: number, count: number) => PAD.left + (i / (count - 1)) * PLOT_W;
const y = (rate: number) => PAD.top + ((Y_MAX - rate) / (Y_MAX - Y_MIN)) * PLOT_H;

export function PaymentPerformance({ series }: { series: SuccessRateSeries }) {
  const { points, incident, baseline, current } = series;
  const count = points.length;

  /**
   * The dip annotation, or nothing.
   *
   * `incident` is nullable now (D-104). A merchant whose gateway behaved has no
   * degradation to point at, and drawing one anyway — at the day's lowest
   * bucket, which is what a non-null placeholder would have to pick — would put
   * a red marker and the words "Degradation detected" on a healthy chart. The
   * line, the baseline and the axis are all still drawn; only the annotation is
   * conditional.
   */
  const dip =
    incident === null
      ? null
      : {
          trough: points[incident.index]?.rate ?? baseline,
          from: x(incident.index - 1, count),
          to: x(incident.index + 3, count),
          markerX: x(incident.index, count),
        };

  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i, count)} ${y(p.rate)}`).join(" ");
  const area = `${line} L${x(count - 1, count)} ${PAD.top + PLOT_H} L${x(0, count)} ${
    PAD.top + PLOT_H
  } Z`;


  return (
    <Section
      title="Payment success rate"
      action={
        <span className="flex shrink-0 items-baseline gap-3">
          <span className="mono text-[13px] text-txt">{current}%</span>
          <span className="meta">baseline {baseline}%</span>
        </span>
      }
    >
      <div className="px-3 pb-1 pt-2">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full"
          role="img"
          aria-label={
            incident && dip
              ? `Payment success rate over 24 hours. Current ${current} percent against a ${baseline} percent baseline. Degradation detected at ${incident.at}, trough ${dip.trough} percent, ${incident.casesOpened} cases opened.`
              : `Payment success rate over 24 hours. Current ${current} percent against a ${baseline} percent baseline. No degradation detected.`
          }
        >
          <defs>
            <linearGradient id="rate-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-diagnosis)" stopOpacity="0.2" />
              <stop offset="100%" stopColor="var(--color-diagnosis)" stopOpacity="0" />
            </linearGradient>
          </defs>

          {[100, 80, 60].map((tick) => (
            <g key={tick}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={y(tick)}
                y2={y(tick)}
                stroke="rgba(255,253,248,0.16)"
                strokeWidth="1"
                strokeDasharray="2 7"
              />
              <text
                x={PAD.left - 6}
                y={y(tick) + 3.5}
                textAnchor="end"
                fill="var(--color-txt-faint)"
                fontSize="10"
              >
                {tick}
              </text>
            </g>
          ))}

          {/* The window the z-score monitor flagged, when it flagged one. */}
          {dip ? (
            <rect
              x={dip.from}
              y={PAD.top}
              width={dip.to - dip.from}
              height={PLOT_H}
              fill="var(--color-halted)"
              fillOpacity="0.08"
            />
          ) : null}

          <line
            x1={PAD.left}
            x2={W - PAD.right}
            y1={y(baseline)}
            y2={y(baseline)}
            stroke="var(--color-txt-dim)"
            strokeWidth="1"
            strokeDasharray="5 5"
            strokeOpacity="0.75"
          />

          <path d={area} fill="url(#rate-fill)" />
          {/* Cosmetic tooth only: displacement is capped near a pixel and the
              marker below is drawn unfiltered, so the trough sits on its true
              coordinate. */}
          <g className="chalk-stroke" filter="url(#chalk-tooth)">
            <path
              d={line}
              fill="none"
              stroke="var(--color-diagnosis)"
              strokeWidth="2.2"
              strokeOpacity="0.95"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </g>

          {dip ? (
            <>
              <line
                x1={dip.markerX}
                x2={dip.markerX}
                y1={y(dip.trough)}
                y2={PAD.top + PLOT_H}
                stroke="var(--color-halted)"
                strokeWidth="1"
                strokeDasharray="3 3"
                strokeOpacity="0.7"
              />
              <circle cx={dip.markerX} cy={y(dip.trough)} r="2.8" fill="var(--color-halted)" />
            </>
          ) : null}

          {[0, 12, 24, 36, count - 1].map((i) => (
            <text
              key={i}
              x={x(i, count)}
              y={PAD.top + PLOT_H + 15}
              textAnchor={i === 0 ? "start" : i === count - 1 ? "end" : "middle"}
              fill="var(--color-txt-faint)"
              fontSize="10"
            >
              {points[i].t}
            </text>
          ))}
        </svg>
      </div>

      {/* The one alert this panel exists to raise — and the honest line when
          there is nothing to raise. A panel that only ever appears during an
          incident is a panel nobody knows is working. */}
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 border-t border-white/[0.06] px-5 py-3">
        {incident && dip ? (
          <>
            <span
              className="h-[6px] w-[6px] shrink-0 translate-y-[-1px] rounded-full bg-halted"
              aria-hidden
            />
            <span className="text-[13px] text-txt">Degradation detected {incident.at}</span>
            <span className="mono text-[11.5px] text-txt-faint">
              trough {dip.trough}% · {incident.casesOpened} cases opened · recovered{" "}
              {incident.recoveredAt}
            </span>
            <ChalkNote tone="gold" className="ml-0.5">
              BOA → silent retry, no customer contact
            </ChalkNote>
          </>
        ) : (
          <>
            <span
              className="h-[6px] w-[6px] shrink-0 translate-y-[-1px] rounded-full bg-recovered"
              aria-hidden
            />
            <span className="text-[13px] text-txt">No degradation detected today</span>
            <span className="mono text-[11.5px] text-txt-faint">
              z-score monitor watching 5-minute buckets against the trailing hour
            </span>
          </>
        )}
      </div>
    </Section>
  );
}
