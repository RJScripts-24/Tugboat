import type { ReactNode } from "react";

import { TONE_HEX, type Tone } from "@/lib/dashboard-data";
import { formatRupees, formatRupeesExact } from "@/lib/money";
import { ChalkRule } from "./chalk";

/**
 * Shared console primitives (PRD 6.4).
 *
 * Deliberately few and deliberately plain: a money value, a status marker, a
 * section frame. Consistency here is what stops the page from reading as a
 * collection of components rather than one instrument.
 */

/* ------------------------------------------------------------------ */

export function MoneyValue({
  paise,
  exact = false,
  className = "",
}: {
  paise: number;
  /** Paise precision - used for the cost-per-₹100 figure. */
  exact?: boolean;
  className?: string;
}) {
  return (
    <span className={`tabular ${className}`}>
      <span className="opacity-60">₹</span>
      {exact ? formatRupeesExact(paise) : formatRupees(paise)}
    </span>
  );
}

/* ------------------------------------------------------------------ */

/**
 * A status marker, not a badge: a 6px square and a word. Filled pills at every
 * row turn a table into a christmas tree; a square reads as fast and stays out
 * of the way.
 */
export function StatusMark({
  tone,
  children,
  pulsing = false,
}: {
  tone: Tone;
  children: ReactNode;
  pulsing?: boolean;
}) {
  const hex = TONE_HEX[tone];
  return (
    <span className="chalk inline-flex items-center gap-2 whitespace-nowrap text-[12.5px]">
      <span
        className={`h-[6px] w-[6px] shrink-0 rounded-[1px]${pulsing ? " pulse-dot" : ""}`}
        style={{ backgroundColor: hex }}
        aria-hidden
      />
      <span style={{ color: hex }}>{children}</span>
    </span>
  );
}

/* ------------------------------------------------------------------ */

/** A titled region. One hairline, no shadow, no glow, no gradient. */
export function Section({
  title,
  meta,
  action,
  children,
  className = "",
  bodyClassName = "",
}: {
  title: string;
  meta?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`surface flex flex-col ${className}`}>
      <div className="surface-head">
        <h2 className="surface-title">{title}</h2>
        {action ?? (meta ? <span className="meta">{meta}</span> : null)}
      </div>
      <ChalkRule />
      <div className={`flex-1 ${bodyClassName}`}>{children}</div>
    </section>
  );
}
