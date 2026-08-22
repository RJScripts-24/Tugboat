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
/* Case types - one mark per playbook (PRD 3)                          */
/* ------------------------------------------------------------------ */

/** Payment failed - a card, declined. */
export function CardIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <rect x="2.6" y="5.2" width="18.8" height="13.6" rx="2.2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2.6 9.8h18.8" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6 14.4h3.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** Checkout abandoned - the cart left standing. */
export function CartIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path
        d="M2.8 3.8h2.6l2.3 10.4h9.5l2.1-7.4H6.4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="9.4" cy="18.6" r="1.5" fill="currentColor" />
      <circle cx="16.6" cy="18.6" r="1.5" fill="currentColor" />
    </svg>
  );
}

/** Mandate failed - the recurring debit that bounced. */
export function MandateIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path
        d="M4.6 10.4a7.4 7.4 0 0 1 12.6-3.6l2 2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M19.4 13.6a7.4 7.4 0 0 1-12.6 3.6l-2-2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path d="M19.6 4.6v4.4h-4.4M4.4 19.4V15h4.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Invoice overdue - the document past its date. */
export function InvoiceIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path
        d="M5.4 3.4h9.2l4 4v13.2H5.4V3.4Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M14.2 3.6v4.2h4.2" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M8.4 12.2h7.2M8.4 15.8h4.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** Filter menus and sort headers. */
export function ChevronDownIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path d="m5.4 9 6.6 6.6L18.6 9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path d="M5.6 5.6 18.4 18.4M18.4 5.6 5.6 18.4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

/** Export - the list, leaving. */
export function DownloadIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path d="M12 3.6v10.8m0 0 4-4m-4 4-4-4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4.4 16.4v2.2a1.8 1.8 0 0 0 1.8 1.8h11.6a1.8 1.8 0 0 0 1.8-1.8v-2.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
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

/* ------------------------------------------------------------------ */
/* Case Detail - timeline marks and controls (PRD 6.3, page 4)         */
/* ------------------------------------------------------------------ */

/** Planned - the route chosen at a fork, with the rejected arm left drawn. */
export function PlanIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path
        d="M12 20.6V13c0-2.4 1.9-4.3 4.3-4.3h3"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 14.4V8.7C12 6.3 10.1 4.4 7.7 4.4h-3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray="2.6 2.8"
        strokeOpacity="0.55"
      />
      <path
        d="m16.8 5.8 3 2.9-3 2.9"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="20.6" r="1.6" fill="currentColor" />
    </svg>
  );
}

/** A policy verdict that went the other way. */
export function ShieldBlockIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path
        d="M12 2.8 5 5.4v5.9c0 4.3 2.9 7.9 7 9.3 4.1-1.4 7-5 7-9.3V5.4L12 2.8Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M9.4 9.4 14.6 14.6M14.6 9.4 9.4 14.6"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Email sent - the envelope, distinct from the paper plane. */
export function MailIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <rect x="2.8" y="5" width="18.4" height="14" rx="2.2" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="m3.6 7 7.3 5.4a1.8 1.8 0 0 0 2.2 0L20.4 7"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** WhatsApp nudge - the chat mark with its tail. */
export function WhatsAppIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path
        d="M12 3.2a8.6 8.6 0 0 0-7.4 13l-1.2 4.4 4.6-1.2A8.6 8.6 0 1 0 12 3.2Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M9 8.4c.4-.1.7 0 .9.4l.7 1.4c.1.3.1.5-.1.8l-.4.5c-.2.2-.2.4-.1.6.6 1.1 1.4 1.8 2.5 2.3.3.1.5.1.6-.1l.5-.5c.2-.2.4-.3.7-.2l1.5.7c.3.2.4.4.4.7 0 .8-.6 1.4-1.4 1.5-2.6.2-6.2-3.4-6.1-6 0-.8.5-1.4 1.3-1.6l.1-.5Z"
        fill="currentColor"
      />
    </svg>
  );
}

/** The customer wrote back. */
export function ReplyIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path
        d="M20.4 11.6c0 3.8-3.8 6.9-8.4 6.9-.9 0-1.8-.1-2.6-.3l-4.4 1.6 1.2-3.6a6.4 6.4 0 0 1-2.6-4.6c0-3.8 3.8-6.9 8.4-6.9s8.4 3.1 8.4 6.9Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M8.8 11.6h6.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** The origin object lives in the Razorpay dashboard, not in here. */
export function ExternalLinkIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path
        d="M13.6 4.4h6v6M19.2 4.8 11 13"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M18.6 14.2v4.4a2 2 0 0 1-2 2H5.4a2 2 0 0 1-2-2V7.4a2 2 0 0 1 2-2h4.4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Copy a hash or an id without selecting it by hand. */
export function CopyIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <rect x="8.4" y="3.4" width="12.2" height="12.2" rx="2.2" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M15.6 18.4v.4a2 2 0 0 1-2 2H5.4a2 2 0 0 1-2-2v-8.2a2 2 0 0 1 2-2h.4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** The human override: stop the agent on this case. */
export function PauseIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path d="M8.6 4.8v14.4M15.4 4.8v14.4" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

/** A rule that cannot be switched off. */
export function LockIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <rect x="4.6" y="10.2" width="14.8" height="10.4" rx="2.2" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M8.2 10.2V7.6a3.8 3.8 0 0 1 7.6 0v2.6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Chain integrity verified. */
export function ChainIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path
        d="M10 14a3.6 3.6 0 0 1 0-5l2.4-2.4a3.6 3.6 0 0 1 5.1 5.1L16.2 13"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M14 10a3.6 3.6 0 0 1 0 5l-2.4 2.4a3.6 3.6 0 0 1-5.1-5.1L7.8 11"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** A plain tick, for checklists that are not shields. */
export function CheckIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path
        d="m5 12.6 4.6 4.6L19 6.8"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Approvals                                                           */
/* ------------------------------------------------------------------ */

/** A decision taken by a person: the gavel, struck. */
export function GavelIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path
        d="m9.6 4.4 5.4 5.4M12.4 3 17 7.6M7.4 6.6 12 11.2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="m11.6 9.4-6 6a1.9 1.9 0 0 0 2.7 2.7l6-6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M13.6 20.4h7.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** Time a request has been waiting - an hourglass, not a spinner. */
export function HourglassIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path d="M6.6 3.6h10.8M6.6 20.4h10.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path
        d="M7.8 3.6v3.1c0 1.9 4.2 3.6 4.2 5.3s-4.2 3.4-4.2 5.3v3.1M16.2 3.6v3.1c0 1.9-4.2 3.6-4.2 5.3s4.2 3.4 4.2 5.3v3.1"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The draft, before anybody has signed it off. */
export function DraftIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path
        d="M6 3.6h7.4L18.4 8.6v11.8H6z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M13.2 3.8v5h5" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M8.8 13.2h6.4M8.8 16.4h4.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** Editing that draft: the pencil. */
export function PencilIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path
        d="M15.6 4.4 19.6 8.4M4.4 19.6l1-4 10.2-10.2 4 4L9.4 19.6z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
