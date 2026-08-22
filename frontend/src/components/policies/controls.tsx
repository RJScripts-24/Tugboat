"use client";

import type { ReactNode } from "react";

import { LockIcon } from "@/components/dashboard/icons";

/**
 * The form vocabulary of the Policies page.
 *
 * Four things - a labelled row, a switch, a bounded number, and a locked
 * marker - and every section on the page is built from them. Kept to four on
 * purpose: this is the one page in the console that is a form, and a form
 * assembled from a dozen bespoke widgets is a form that reads as a dozen
 * different products.
 *
 * Every control here reports whether it is currently different from the saved
 * pack. That is not decoration - it is the difference between a page that
 * lists six pending changes at the bottom and a page that shows you where they
 * are.
 */

/* ------------------------------------------------------------------ */

/**
 * One setting: what it is, what it is set to, and what it does.
 *
 * The explanatory caption is required rather than optional. A guardrail whose
 * effect is not written next to it is a guardrail a merchant switches off
 * without knowing what they bought.
 */
export function PolicyRow({
  label,
  control,
  caption,
  effect,
  changed = false,
  off = false,
  locked = false,
  children,
}: {
  label: ReactNode;
  control: ReactNode;
  caption: ReactNode;
  /** What this bound actually did on the last batch, where it can be measured. */
  effect?: ReactNode;
  changed?: boolean;
  /** Rendered as absent-but-present: the rule is off, not gone. */
  off?: boolean;
  locked?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="policy-row px-5 py-3.5" data-changed={changed} data-off={off}>
      <div className="flex items-start justify-between gap-4">
        <div className="policy-dim min-w-0">
          <p className="chalk-hand flex items-center gap-2 text-[14px] uppercase tracking-[0.06em] text-txt">
            {label}
            {locked ? <LockedMark /> : null}
            {changed ? (
              <span className="mono text-[10.5px] uppercase tracking-[0.08em] text-waiting">
                unsaved
              </span>
            ) : null}
          </p>
          <p className="mt-1.5 max-w-[62ch] text-[11.5px] leading-[1.6] text-txt-faint">
            {caption}
          </p>
        </div>
        <div className="shrink-0 pt-[1px]">{control}</div>
      </div>

      {children ? <div className="policy-dim mt-3">{children}</div> : null}

      {effect ? (
        <p className="mono policy-dim mt-2.5 text-[11px] leading-[1.5] text-txt-dim">{effect}</p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */

/** "non-negotiable", said in the smallest space it can be said in. */
export function LockedMark({ label = "locked" }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-[10.5px] uppercase tracking-[0.07em] text-waiting">
      <LockIcon className="h-[10px] w-[10px]" />
      {label}
    </span>
  );
}

/* ------------------------------------------------------------------ */

/**
 * A switch.
 *
 * A locked switch renders as a switch rather than as a statement, because the
 * point being made is that this one control cannot be moved - and a control
 * that has been replaced by a sentence does not make that point, it just
 * disappears.
 */
export function Switch({
  on,
  onChange,
  label,
  locked = false,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  /** Read by a screen reader in place of the visible row label. */
  label: string;
  locked?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      aria-disabled={locked || undefined}
      disabled={locked}
      title={locked ? "This rule cannot be switched off" : undefined}
      className="chalk-switch"
      data-on={on}
      data-locked={locked}
      onClick={() => {
        if (!locked) onChange(!on);
      }}
    />
  );
}

/* ------------------------------------------------------------------ */

/**
 * A bounded number with a step that means something.
 *
 * No free text entry: every value on this page is a cap or a threshold with a
 * sensible floor and ceiling, and a field a merchant can type 400 into is a
 * field that eventually has 400 in it. The bounds are the control.
 */
export function Stepper({
  value,
  onChange,
  min,
  max,
  step = 1,
  format,
  label,
  disabled = false,
}: {
  value: number;
  onChange: (next: number) => void;
  min: number;
  max: number;
  step?: number;
  /** How the number reads: "4", "20h", "₹25,000", "0.60". */
  format: (value: number) => string;
  label: string;
  disabled?: boolean;
}) {
  // Stepping in floating-point units (0.05 confidence, 0.05 sentiment) drifts
  // into 0.6500000000000001 within three clicks, and a threshold that renders
  // as garbage is a threshold nobody believes. Snap to the step's grid.
  const snap = (next: number) => {
    const decimals = (String(step).split(".")[1] ?? "").length;
    const clamped = Math.min(max, Math.max(min, next));
    return Number(clamped.toFixed(decimals));
  };

  return (
    <span className="stepper" role="group" aria-label={label}>
      <button
        type="button"
        className="stepper-btn"
        aria-label={`Decrease ${label}`}
        disabled={disabled || value <= min}
        onClick={() => onChange(snap(value - step))}
      >
        <MinusGlyph />
      </button>
      <span className="stepper-value" aria-live="off">
        {format(value)}
      </span>
      <button
        type="button"
        className="stepper-btn"
        aria-label={`Increase ${label}`}
        disabled={disabled || value >= max}
        onClick={() => onChange(snap(value + step))}
      >
        <PlusGlyph />
      </button>
    </span>
  );
}

function MinusGlyph() {
  return (
    <svg viewBox="0 0 12 12" className="h-[11px] w-[11px]" fill="none" aria-hidden>
      <path d="M2.4 6h7.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function PlusGlyph() {
  return (
    <svg viewBox="0 0 12 12" className="h-[11px] w-[11px]" fill="none" aria-hidden>
      <path
        d="M2.4 6h7.2M6 2.4v7.2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/* ------------------------------------------------------------------ */

/**
 * A count drawn as pips, for caps small enough to see at a glance.
 *
 * The same mark the Case Detail bounds panel uses for attempts, reused here
 * so a merchant setting the cap and an operator watching it get spent are
 * looking at the same object.
 */
export function PipRow({ count, max = 8 }: { count: number; max?: number }) {
  return (
    <span className="flex gap-1.5" aria-hidden>
      {Array.from({ length: max }, (_, i) => (
        <span key={i} className="pip" data-used={i < count} />
      ))}
    </span>
  );
}
