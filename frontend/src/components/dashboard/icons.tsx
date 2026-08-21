import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

/**
 * Control Tower marks.
 *
 * The landing icons are 72-box line art built to glow at 90px; these are their
 * 24-box working cousins, drawn to stay legible at 15px in a nav rail or an
 * activity feed. Same hand: flat vectors, `currentColor`, ink cut-outs.
 */

/* ------------------------------------------------------------------ */
/* Navigation                                                          */
/* ------------------------------------------------------------------ */

/** Control Tower - a radar sweep, the landing's Detect mark compressed. */
export function TowerIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <circle cx="12" cy="12" r="8.6" stroke="currentColor" strokeWidth="1.5" strokeOpacity="0.55" />
      <circle cx="12" cy="12" r="4.6" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
      <path d="M12 12 5.9 5.9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="17.2" cy="7.4" r="1.3" fill="currentColor" />
    </svg>
  );
}

/** Pipeline - cases queued in stages. */
export function PipelineIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <rect x="3.2" y="4.4" width="17.6" height="4.4" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="3.2" y="11" width="12.6" height="4.4" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="3.2" y="17.6" width="7.6" height="2.8" rx="1.4" fill="currentColor" />
    </svg>
  );
}

/** Approvals - a raised hand: the agent asking permission. */
export function ApprovalIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path
        d="M9 11.4V4.6a1.4 1.4 0 0 1 2.8 0v6M11.8 10.6V3.9a1.4 1.4 0 0 1 2.8 0v6.7M14.6 11V5.8a1.4 1.4 0 0 1 2.8 0v7.6c0 3.6-2.3 6.4-5.8 6.4-2.6 0-4.2-1.2-5.3-3.3L4.6 13c-.5-.9-.1-1.8.7-2.2.7-.4 1.6-.2 2.1.5L9 13.6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Simulation Lab - the flask the batch runs in. */
export function FlaskIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path
        d="M9.4 3.2v5.5L4.6 17a2.4 2.4 0 0 0 2.1 3.6h10.6a2.4 2.4 0 0 0 2.1-3.6l-4.8-8.3V3.2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M8.2 3.2h7.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M6.9 14.6h10.2l2.2 3.8-1.9 2.2H6.6l-1.9-2.5 2.2-3.5Z" fill="currentColor" fillOpacity="0.55" />
    </svg>
  );
}

/** Audit - the ledger, chained. */
export function LedgerIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <rect x="4.2" y="3" width="15.6" height="18" rx="2.4" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7.8 8h8.4M7.8 12h8.4M7.8 16h4.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** Policies - a shield with a slider through it: bounds you can tune. */
export function PolicyIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path
        d="M12 2.8 4.8 5.5v6c0 4.4 3 8.1 7.2 9.6 4.2-1.5 7.2-5.2 7.2-9.6v-6L12 2.8Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M8.4 10.4h7.2M8.4 14h7.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="10.6" cy="10.4" r="1.5" fill="currentColor" />
      <circle cx="13.4" cy="14" r="1.5" fill="currentColor" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Activity feed - one mark per action type (PRD 6.3, page 2)          */
/* ------------------------------------------------------------------ */

/** Detect. */
export function MagnifierSmallIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <circle cx="10.6" cy="10.6" r="6.4" stroke="currentColor" strokeWidth="1.7" />
      <path d="m15.4 15.4 4.4 4.4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

/** Diagnose - the stethoscope. */
export function StethoscopeIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path
        d="M6 3.2v5.2a4 4 0 0 0 8 0V3.2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path d="M4.4 3.2h3.2M12.4 3.2h3.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path
        d="M10 12.4v2.4a4.6 4.6 0 0 0 9.2 0v-1.6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="19.2" cy="10.6" r="2.3" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

/** Message sent - email or WhatsApp. */
export function SendIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path d="M21 3 3 10.6l7.4 2.9L21 3Z" fill="currentColor" />
      <path d="M21 3 10.4 13.5 12 21l3.2-5.2L21 3Z" fill="currentColor" fillOpacity="0.6" />
    </svg>
  );
}

/** Voice call. */
export function PhoneIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path
        d="M8.1 4.2c.5-.9.9-1 1.4-1h1c.4 0 .7.1 1 .8l1.2 2.8c.1.3 0 .6-.2.8l-.9.9c-.3.3-.3.6-.1.9a10.4 10.4 0 0 0 4.5 3.9c.3.2.6.1.8-.1l.9-1c.2-.3.5-.3.8-.2l2.7 1.3c.4.2.6.4.6.8 0 1-.5 2-1.3 2.4-2.2.8-5.5-.5-8.2-3-2.8-2.5-4.4-5.7-4.4-7.9 0-.4 0-.8.2-1.2l-.1-.2Z"
        fill="currentColor"
      />
    </svg>
  );
}

/** Escalated to a human. */
export function EscalateIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path
        d="M12 3.4 12 15.4M12 3.4 7.4 8M12 3.4 16.6 8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M4.6 19.4h14.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/** Halted by a stopping rule - the octagon. */
export function HaltIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path
        d="M8.3 3.2h7.4l5.1 5.1v7.4l-5.1 5.1H8.3l-5.1-5.1V8.3l5.1-5.1Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M8.6 12h6.8" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

/** Retry executed against Razorpay. */
export function RetryIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path
        d="M20 12a8 8 0 1 1-2.6-5.9"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <path
        d="M20.4 3.4v4.4H16"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Money recovered - the only green mark in the product. */
export function RecoveredIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <circle cx="12" cy="12" r="9.2" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="m7.9 12.2 2.8 2.8 5.4-6"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A policy verdict was written. */
export function ShieldCheckSmallIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path
        d="M12 2.8 5 5.4v5.9c0 4.3 2.9 7.9 7 9.3 4.1-1.4 7-5 7-9.3V5.4L12 2.8Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="m8.9 11.8 2.2 2.2 4-4.4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Promise to pay recorded. */
export function PromiseIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <rect x="3.4" y="4.8" width="17.2" height="15.4" rx="2.6" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3.4 9.4h17.2M8 3.2v3.2M16 3.2v3.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path
        d="m9 14.6 2 2 4-4.2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Chrome                                                              */
/* ------------------------------------------------------------------ */

export function ClockSmallIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <circle cx="12" cy="12" r="8.8" stroke="currentColor" strokeWidth="1.5" />
      <path d="M12 6.8V12l3.6 2.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path d="M7.4 4.6 19.2 12 7.4 19.4V4.6Z" fill="currentColor" />
    </svg>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path d="m9.6 5.4 6.6 6.6-6.6 6.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function SignOutIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path
        d="M14.4 7.4V5.2a2 2 0 0 0-2-2H5.6a2 2 0 0 0-2 2v13.6a2 2 0 0 0 2 2h6.8a2 2 0 0 0 2-2v-2.2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M9.8 12h10.6m0 0-3.2-3.2M20.4 12l-3.2 3.2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
