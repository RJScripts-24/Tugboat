import type { ReactNode } from "react";

/**
 * Chalk drawing primitives.
 *
 * Everything drawn on the board - pipeline strokes, chart lines, rules,
 * arrowheads - comes through here, so the material stays consistent and the
 * cost stays fixed: two static SVG filters defined once per page, plus paths.
 * No canvas, no per-element filters, nothing that repaints on scroll.
 *
 * The irregularity is deterministic. A seeded hash drives every wobble, so the
 * server and the client draw the identical path and the same stage always looks
 * the same on reload - a line that reshuffles itself on every render reads as a
 * glitch, not as chalk.
 */

/* ------------------------------------------------------------------ */
/* Deterministic wobble                                                */
/* ------------------------------------------------------------------ */

/** FNV-1a, then a cheap integer mix - stable across server and browser. */
function seeded(seed: string, count: number): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h ^= h >>> 13;
    out.push(((h >>> 0) % 2000) / 1000 - 1); // -1 .. 1
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Filters                                                             */
/* ------------------------------------------------------------------ */

/**
 * Rendered once per page. `chalk-edge` roughens a stroke's outline;
 * `chalk-tooth` is the same idea at a finer frequency for chart lines, where
 * displacement has to stay under a pixel so the plotted values remain true.
 */
export function ChalkFilters() {
  return (
    <svg width="0" height="0" aria-hidden className="absolute" focusable="false">
      <defs>
        <filter id="chalk-edge" x="-6%" y="-40%" width="112%" height="180%">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.055 0.11"
            numOctaves="3"
            seed="11"
            result="noise"
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="noise"
            scale="2.1"
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>

        <filter id="chalk-tooth" x="-3%" y="-12%" width="106%" height="124%">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.09 0.16"
            numOctaves="2"
            seed="5"
            result="noise"
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="noise"
            scale="1.1"
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </defs>
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Strokes                                                             */
/* ------------------------------------------------------------------ */

/**
 * A chalk stroke of a given length.
 *
 * `fraction` is the data. The wobble is cosmetic and lives entirely in the
 * vertical axis, so the stroke's *length* - the only thing encoding a value -
 * stays exact to the pixel.
 */
export function ChalkStroke({
  fraction,
  color,
  seed,
  height = 14,
  label,
}: {
  fraction: number;
  color: string;
  seed: string;
  height?: number;
  label?: string;
}) {
  const W = 400;
  const H = 24;
  const mid = H / 2;
  const clamped = Math.max(0, Math.min(1, fraction));
  // Nothing recovered has to look like nothing recovered: a minimum-length
  // stub would read as a small value rather than as zero.
  if (clamped <= 0.001) return <ChalkTrack height={height} />;
  const end = Math.max(6, clamped * W);

  const jitter = seeded(seed, 6);
  const points: string[] = [];
  const steps = 5;
  for (let i = 0; i <= steps; i += 1) {
    const x = (end / steps) * i;
    // Ends sit true; the belly of the line is where a hand wanders.
    const damp = i === 0 || i === steps ? 0.25 : 1;
    points.push(`${x.toFixed(1)} ${(mid + jitter[i] * 1.15 * damp).toFixed(2)}`);
  }

  const path = points
    .map((p, i) => (i === 0 ? `M${p}` : `L${p}`))
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="chalk-stroke block w-full"
      style={{ height }}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <g filter="url(#chalk-edge)">
        {/*
          Stroke width is in user units, not device pixels.
          `vector-effect: non-scaling-stroke` does not survive the
          non-uniform scale that `preserveAspectRatio="none"` applies
          here - it rendered a hairline instead of a chalk mark - so the
          width is pre-divided by the vertical scale (height / viewBox
          height) to land at the thickness actually wanted on screen.
        */}
        <path
          d={path}
          fill="none"
          stroke={color}
          strokeWidth={(9 * H) / height}
          strokeLinecap="round"
          strokeOpacity="1"
        />
      </g>
    </svg>
  );
}

/** The faint groove a stroke is measured against. */
export function ChalkTrack({ height = 14 }: { height?: number }) {
  return (
    <svg
      viewBox="0 0 400 24"
      preserveAspectRatio="none"
      className="chalk-stroke block w-full"
      style={{ height }}
      aria-hidden
      focusable="false"
    >
      <path
        d="M0 12 L400 12"
        fill="none"
        stroke="rgba(255,253,248,0.9)"
        strokeWidth="1"
        strokeOpacity="0.26"
        strokeDasharray="3 6"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Notes                                                               */
/* ------------------------------------------------------------------ */

/**
 * A note added beside the data in a different hand.
 *
 * Only ever renders something already present in the application's state - a
 * derived observation or an existing decision. Nothing here is authored copy
 * pretending to be analysis.
 */
export function ChalkNote({
  children,
  tone = "dim",
  arrow = false,
  className = "",
}: {
  children: ReactNode;
  tone?: "dim" | "gold" | "green" | "red" | "blue";
  arrow?: boolean;
  className?: string;
}) {
  const color = {
    dim: "var(--color-txt-dim)",
    gold: "var(--color-waiting)",
    green: "var(--color-recovered)",
    red: "var(--color-halted)",
    blue: "var(--color-diagnosis)",
  }[tone];

  return (
    <span
      className={`chalk-hand inline-flex items-center gap-1.5 text-[13px] leading-none ${className}`}
      style={{ color }}
    >
      {arrow ? <ChalkTick color={color} /> : null}
      {children}
    </span>
  );
}

/** The little hooked arrow a note is tied to its subject with. */
function ChalkTick({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 18 10" className="h-[9px] w-[16px] shrink-0" aria-hidden focusable="false">
      <g filter="url(#chalk-tooth)">
        <path
          d="M1 5.4 C5 5.1, 9 5.6, 14.4 5"
          fill="none"
          stroke={color}
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeOpacity="0.8"
        />
        <path
          d="M11.4 2.6 L15.2 5 L11.4 7.5"
          fill="none"
          stroke={color}
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeOpacity="0.8"
        />
      </g>
    </svg>
  );
}

/** A drawn divider. Cheap enough to use anywhere a border was. */
export function ChalkRule({ className = "" }: { className?: string }) {
  return <div className={`chalk-rule ${className}`} aria-hidden />;
}
