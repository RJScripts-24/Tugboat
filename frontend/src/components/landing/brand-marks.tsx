/**
 * Partner marks for the "trusted by" strip.
 *
 * Drawn in-house (glyph as inline SVG + the wordmark as real text) so the strip
 * ships self-contained and sizes predictably; each inherits `currentColor`.
 */

function Chevrons({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 26 20" className={className} fill="none" aria-hidden>
      <path d="M2 3.5 9.5 10 2 16.5" stroke="currentColor" strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round" />
      <path
        d="M13 3.5 20.5 10 13 16.5"
        stroke="currentColor"
        strokeWidth="3.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.62"
      />
    </svg>
  );
}

export function RazorpayWordmark() {
  return (
    <span className="flex items-center gap-[7px]">
      <svg viewBox="0 0 22 26" className="h-[26px] w-[22px]" fill="none" aria-hidden>
        <path d="M13.4 0 7.6 26h4L18.9 0h-5.5Z" fill="currentColor" />
        <path d="M8.8 4.4 3.2 26h4l4.2-15.5-2.6-6.1Z" fill="currentColor" fillOpacity="0.7" />
      </svg>
      <span className="text-[27px] font-bold leading-none tracking-[-0.03em]">Razorpay</span>
    </span>
  );
}

export function UpiWordmark() {
  return (
    <span className="flex items-center gap-[6px]">
      <span className="text-[27px] font-bold leading-none tracking-[0.06em]">UPI</span>
      <Chevrons className="h-[18px] w-[24px]" />
    </span>
  );
}

export function RupayWordmark() {
  return (
    <span className="flex items-center gap-[5px]">
      <span className="text-[27px] font-extrabold italic leading-none tracking-[-0.035em]">RuPay</span>
      <Chevrons className="h-[18px] w-[24px]" />
    </span>
  );
}

export function WhatsAppBusinessWordmark() {
  return (
    <span className="flex items-center gap-[9px]">
      <svg viewBox="0 0 28 28" className="h-[24px] w-[24px]" fill="none" aria-hidden>
        <circle cx="14" cy="14" r="12.8" stroke="currentColor" strokeWidth="1.7" />
        <path
          d="M10.1 9.6c.4-.9.8-.9 1.2-.9h.9c.3 0 .6 0 .9.7l1 2.4c.1.3 0 .5-.2.7l-.7.7c-.2.2-.3.4-.1.7a8.5 8.5 0 0 0 3.8 3.3c.3.1.5.1.7-.1l.8-.9c.2-.2.4-.2.7-.1l2.3 1.1c.3.1.5.3.5.6 0 .8-.4 1.7-1.1 2-1.9.7-4.7-.4-7-2.5-2.4-2.2-3.7-4.9-3.8-6.7 0-.4 0-.7.1-1Z"
          fill="currentColor"
        />
      </svg>
      <span className="text-[21px] font-medium leading-none tracking-[-0.01em]">WhatsApp Business</span>
    </span>
  );
}

export function TwilioWordmark() {
  return (
    <span className="flex items-center gap-[9px]">
      <svg viewBox="0 0 28 28" className="h-[26px] w-[26px]" fill="none" aria-hidden>
        <circle cx="14" cy="14" r="13.2" fill="currentColor" />
        <circle cx="10.1" cy="10.1" r="2.7" fill="#071320" />
        <circle cx="17.9" cy="10.1" r="2.7" fill="#071320" />
        <circle cx="10.1" cy="17.9" r="2.7" fill="#071320" />
        <circle cx="17.9" cy="17.9" r="2.7" fill="#071320" />
      </svg>
      <span className="text-[28px] font-bold leading-none tracking-[-0.035em]">twilio</span>
    </span>
  );
}

export function AwsWordmark() {
  return (
    <span className="flex flex-col items-center gap-[3px]">
      <span className="text-[27px] font-bold leading-none tracking-[-0.06em]">aws</span>
      <svg viewBox="0 0 46 10" className="h-[10px] w-[46px]" fill="none" aria-hidden>
        <path d="M1.5 2.2C10 8.4 27 8.9 37 3.4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <path d="M33.6 1.2 40.5 4l-7.4 2.6.5-5.4Z" fill="currentColor" />
      </svg>
    </span>
  );
}
