import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

/**
 * Sign-in marks, drawn in the same hand as the landing icons: flat vectors on a
 * 24-box, `currentColor` throughout, cut-outs painted in ink so a filled shape
 * reads at 16px as well as at 40.
 */

/* ------------------------------------------------------------------ */
/* Field marks                                                         */
/* ------------------------------------------------------------------ */

/**
 * Username - a ship's wheel, because Boa is the one at it.
 *
 * Drawn out to the edges of the box (3 to 21) rather than politely inset: at
 * 19px in a form field a smaller rim with a heavy hub reads as a cog.
 */
export function HelmIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path
        d="M12 5.8v12.4M5.8 12h12.4"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeOpacity="0.5"
      />
      <circle cx="12" cy="12" r="6.2" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="12" cy="12" r="1.8" fill="currentColor" />
      <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <path d="M12 5.8V3M12 18.2V21M18.2 12H21M5.8 12H3" />
        <path d="m16.38 16.38 1.98 1.98M7.62 16.38 5.64 18.36M16.38 7.62l1.98-1.98M7.62 7.62 5.64 5.64" />
      </g>
    </svg>
  );
}

/** Password - a padlock, keyhole punched out. */
export function LockIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path
        d="M8.1 10.5V7.9a3.9 3.9 0 0 1 7.8 0v2.6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <rect
        x="4.4"
        y="10.5"
        width="15.2"
        height="10.4"
        rx="2.8"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path
        d="M12 14.2a1.5 1.5 0 0 1 .75 2.8v1.3a.75.75 0 0 1-1.5 0V17A1.5 1.5 0 0 1 12 14.2Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function EyeIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path
        d="M2.6 12S6.2 5.9 12 5.9 21.4 12 21.4 12 17.8 18.1 12 18.1 2.6 12 2.6 12Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="2.9" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function EyeOffIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path
        d="M6.2 7.3C4 8.9 2.6 12 2.6 12s3.6 6.1 9.4 6.1c1.6 0 3-.5 4.2-1.1M9.6 6.3A9 9 0 0 1 12 5.9c5.8 0 9.4 6.1 9.4 6.1a16 16 0 0 1-2.9 3.4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9.9 9.9a2.9 2.9 0 0 0 4.1 4.1"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path d="m4.6 4.6 14.8 14.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Feedback + brand                                                    */
/* ------------------------------------------------------------------ */

export function AlertIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <circle cx="12" cy="12" r="9.1" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 7.3v5.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="16.2" r="1.15" fill="currentColor" />
    </svg>
  );
}

/** Spinner - pair with `animate-spin`; the gap is what reads as motion. */
export function SpinnerIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.6" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * The tugboat mark: chunky flat vector, one colour plus ink cut-outs, pennant
 * flying as on the wordmark. Superstructure and funnel meet the deck as one
 * solid mass - detached shapes fall apart at button size.
 */
export function TugboatMarkIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      {/* mast + pennant */}
      <path d="M9.4 8.6V4.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M10 4.3h3.3l-1.05 1.45L13.3 7.2H10V4.3Z" fill="currentColor" />
      {/* funnel, seated on the deck */}
      <path d="M15 8.4h2.9v5.4H15V8.4Z" fill="currentColor" fillOpacity="0.92" />
      <rect x="14.4" y="7.2" width="4.1" height="1.6" rx="0.7" fill="currentColor" />
      {/* wheelhouse */}
      <path d="M6.6 10.1A1.7 1.7 0 0 1 8.3 8.4h4A1.7 1.7 0 0 1 14 10.1v3.7H6.6v-3.7Z" fill="currentColor" />
      <rect x="7.9" y="10.4" width="1.9" height="1.9" rx="0.55" fill="#0a1220" />
      <rect x="10.6" y="10.4" width="1.9" height="1.9" rx="0.55" fill="#0a1220" />
      {/* hull */}
      <path
        d="M2.4 13.8h19.2l-1.5 3.9a3 3 0 0 1-2.8 1.9H6.7a3 3 0 0 1-2.8-1.9L2.4 13.8Z"
        fill="currentColor"
      />
      {/* water */}
      <path
        d="M1.8 20.9c1.4 0 1.4-1.1 2.8-1.1s1.4 1.1 2.8 1.1 1.4-1.1 2.8-1.1 1.4 1.1 2.8 1.1 1.4-1.1 2.8-1.1 1.4 1.1 2.8 1.1"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeOpacity="0.55"
      />
    </svg>
  );
}
