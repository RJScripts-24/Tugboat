import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

/* ------------------------------------------------------------------ */
/* Stage icons - glowing line art, one per pipeline stage              */
/* ------------------------------------------------------------------ */

/** 01 Detect - a radar sweeping for revenue at risk. */
export function RadarIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 72 72" fill="none" aria-hidden {...props}>
      <circle cx="36" cy="36" r="33" stroke="currentColor" strokeOpacity="0.28" strokeWidth="1" />
      <circle
        cx="36"
        cy="36"
        r="28"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeDasharray="30 12"
      />
      <circle cx="36" cy="36" r="18.5" stroke="currentColor" strokeWidth="2.2" strokeOpacity="0.85" />
      <circle cx="36" cy="36" r="9" stroke="currentColor" strokeWidth="2" strokeOpacity="0.7" />
      <circle cx="36" cy="36" r="2.6" fill="currentColor" />
      <path d="M36 36 13.5 20" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeOpacity="0.75" />
      <path d="M36 36 55 53" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeOpacity="0.4" />
      <circle cx="24" cy="26" r="1.7" fill="currentColor" fillOpacity="0.9" />
      <circle cx="50" cy="45" r="1.4" fill="currentColor" fillOpacity="0.7" />
      <circle cx="45" cy="24" r="1.2" fill="currentColor" fillOpacity="0.55" />
    </svg>
  );
}

/** 02 Diagnose - magnifier on the root cause. */
export function MagnifierIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 72 72" fill="none" aria-hidden {...props}>
      <circle cx="31" cy="30" r="20.5" stroke="currentColor" strokeWidth="3.4" />
      <path
        d="M18.5 36.5a13.5 13.5 0 0 0 24-4.5"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeOpacity="0.75"
      />
      <path d="M45.6 44.6 60 59" stroke="currentColor" strokeWidth="4.6" strokeLinecap="round" />
      <path d="M43 47.5 47 43.5" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" />
    </svg>
  );
}

/** 03 Decide - reject one path, take the right one. */
export function StrategyIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 72 72" fill="none" aria-hidden {...props}>
      <path d="M12 10 30 28M30 10 12 28" stroke="currentColor" strokeWidth="4.4" strokeLinecap="round" />
      <circle cx="17" cy="53" r="8" stroke="currentColor" strokeWidth="3.6" />
      <circle cx="50" cy="53" r="8" stroke="currentColor" strokeWidth="3.6" strokeOpacity="0.75" />
      <path d="M55.5 58.5 60 63" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeOpacity="0.75" />
      <path d="M25 47c6-8 12-11 21-13.5" stroke="currentColor" strokeWidth="3.8" strokeLinecap="round" />
      <path
        d="M52 32.5 46 24M52 32.5l-9.5 3"
        stroke="currentColor"
        strokeWidth="3.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M46 24 55 12" stroke="currentColor" strokeWidth="3.8" strokeLinecap="round" />
    </svg>
  );
}

/** 04 Execute - the message goes out. */
export function PaperPlaneIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 72 72" fill="none" aria-hidden {...props}>
      <path d="M64 8 8 34.5l21.5 8.2L64 8Z" fill="currentColor" />
      <path d="M64 8 29.5 42.7 33 64l9.5-14.4L64 8Z" fill="currentColor" fillOpacity="0.62" />
      <path d="M29.5 42.7 33 64l9.5-14.4-13-6.9Z" fill="currentColor" fillOpacity="0.85" />
    </svg>
  );
}

/** 05 Measure - recovered rupees, proven. */
export function BarChartIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 72 72" fill="none" aria-hidden {...props}>
      <rect x="8" y="42" width="14" height="22" rx="2.5" fill="currentColor" fillOpacity="0.72" />
      <rect x="8" y="42" width="14" height="4" rx="2" fill="currentColor" />
      <rect x="29" y="27" width="14" height="37" rx="2.5" fill="currentColor" fillOpacity="0.86" />
      <rect x="29" y="27" width="14" height="4" rx="2" fill="currentColor" />
      <rect x="50" y="14" width="14" height="50" rx="2.5" fill="currentColor" fillOpacity="0.72" />
      <rect x="50" y="14" width="14" height="4" rx="2" fill="currentColor" />
      <path
        d="M15 8c.7 4.4 1.6 5.3 6 6-4.4.7-5.3 1.6-6 6-.7-4.4-1.6-5.3-6-6 4.4-.7 5.3-1.6 6-6Z"
        fill="currentColor"
      />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Hero trust-strip icons                                              */
/* ------------------------------------------------------------------ */

export function RazorpayMark(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path d="M14.7 2 8.4 22h4.1L20.6 2h-5.9Z" fill="#3395FF" />
      <path d="M9.4 6.6 3.4 22h4.2l4.4-11.2-2.6-4.2Z" fill="#3395FF" fillOpacity="0.72" />
    </svg>
  );
}

export function ShieldCheckIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path
        d="M12 2.6 4.6 5.4v6.1c0 4.6 3.1 8.4 7.4 9.9 4.3-1.5 7.4-5.3 7.4-9.9V5.4L12 2.6Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="m9 12 2.2 2.2L15.4 10"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function AuditDocIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <rect x="4" y="2.8" width="16" height="18.4" rx="2.4" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 8.6h8M8 12.2h8M8 15.8h4.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function IndiaMapIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path
        d="M8.1 2.2 6.4 4.5l1.9 1.1-1.4 1.7L4 6.6l-1.1 2 2.4 1.7-.5 2.2 2.6.6 1.2 2.6 1.4-.8 1.5 2.1-.6 2.5 1.4 2.5 1.5-2.3 1-4.3 2.6-3.1 2.4-4.5-1.7-1.1.8-2.2-2.6.6-1.9-1.7-2.6 1-1.6-1.7-2.6.5Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* CTA + stat icons                                                    */
/* ------------------------------------------------------------------ */

export function ArrowRightIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden {...props}>
      <path
        d="M3.5 10h13M11.5 5l5 5-5 5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function CalendarIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden {...props}>
      <rect x="2.8" y="4.2" width="14.4" height="13" rx="2.4" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2.8 8.2h14.4M6.6 2.6v3M13.4 2.6v3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <rect x="12" y="11.4" width="2.6" height="2.6" rx="0.7" fill="currentColor" />
    </svg>
  );
}

export function SparkleIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden {...props}>
      <path
        d="M6.1 0c.75 4.6 1.45 5.3 6.1 6.1-4.65.8-5.35 1.5-6.1 6.1C5.35 7.6 4.65 6.9 0 6.1 4.65 5.3 5.35 4.6 6.1 0Z"
        fill="currentColor"
      />
      <path
        d="M13 9.1c.4 2.5.78 2.87 3.28 3.28-2.5.42-2.88.8-3.28 3.29-.4-2.5-.78-2.87-3.28-3.28 2.5-.42 2.88-.8 3.28-3.29Z"
        fill="currentColor"
        fillOpacity="0.9"
      />
    </svg>
  );
}

export function RupeeCircleIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path
        d="M8.6 5.6h6.8M8.6 8.8h6.8M13.6 5.6c1.9 0 3 1.3 3 3.1s-1.1 3.1-3 3.1H8.6l6.4 6.6"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ShieldSolidIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path d="M12 2.2 3.8 5.4v6.3c0 4.9 3.4 9 8.2 10.4 4.8-1.4 8.2-5.5 8.2-10.4V5.4L12 2.2Z" fill="currentColor" />
      <path
        d="m8.4 12 2.6 2.6 4.8-5"
        stroke="#0a1220"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function UsersSolidIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <circle cx="11.6" cy="8" r="3.6" fill="currentColor" />
      <path d="M4.6 19.4c0-3.7 3.1-6 7-6s7 2.3 7 6c0 .6-.5 1-1.1 1H5.7c-.6 0-1.1-.4-1.1-1Z" fill="currentColor" />
      <circle cx="4.6" cy="9.8" r="2.6" fill="currentColor" fillOpacity="0.75" />
      <circle cx="19.2" cy="9.8" r="2.6" fill="currentColor" fillOpacity="0.75" />
      <path
        d="M.8 18.4c0-2.4 1.7-4 3.8-4 .5 0 1 .1 1.4.2-1.2 1.2-2 2.7-2.2 4.5H1.6a.8.8 0 0 1-.8-.7Z"
        fill="currentColor"
        fillOpacity="0.75"
      />
      <path
        d="M23 18.4c0-2.4-1.7-4-3.8-4-.5 0-1 .1-1.4.2 1.2 1.2 2 2.7 2.2 4.5h2.2c.4 0 .8-.3.8-.7Z"
        fill="currentColor"
        fillOpacity="0.75"
      />
    </svg>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <circle cx="12" cy="12" r="9.2" stroke="currentColor" strokeWidth="1.9" />
      <path d="M12 6.4V12l4 2.4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function MenuIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}
