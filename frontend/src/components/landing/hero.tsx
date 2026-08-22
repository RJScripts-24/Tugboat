import Link from "next/link";

import {
  ArrowRightIcon,
  AuditDocIcon,
  IndiaMapIcon,
  ShieldCheckIcon,
  SparkleIcon,
} from "./icons";

/*
 * Claims this product can actually stand behind.
 *
 * "Razorpay Native" used to lead this row and was removed: Tugboat is built
 * against Razorpay's test-mode APIs, which is not the same thing as being a
 * Razorpay product, and a badge a judge from Razorpay would read as false is
 * the worst possible first impression. What is left is checkable in the app -
 * the ledger is on the Audit Explorer, the guardrails are on the Policies
 * page, and the Hinglish and UPI handling is in the cases themselves.
 */
const TRUST = [
  { label: "Audit Ready", Icon: AuditDocIcon, tinted: false },
  { label: "Bounded & Stoppable", Icon: ShieldCheckIcon, tinted: false },
  { label: "Built for India", Icon: IndiaMapIcon, tinted: false },
];

export function Hero() {
  return (
    <section className="relative isolate overflow-hidden bg-ink-900">
      {/* ---- The tugboat, towing ---------------------------------- */}
      <div className="hero-plate pointer-events-none">
        <video
          className="hero-media h-full w-full object-cover object-[62%_center] opacity-80 lg:object-[45%_30%] lg:opacity-100"
          src="/media/hero-tugboat.mp4"
          poster="/media/hero-tugboat-poster.jpg"
          autoPlay
          loop
          muted
          playsInline
          preload="auto"
          aria-hidden
          style={{ filter: "brightness(0.94) saturate(0.97)" }}
        />
      </div>

      {/* Scrim so the copy always sits on ink, never on water */}
      <div
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(2,7,14,0.42)_0%,rgba(2,7,14,0.74)_34%,rgba(2,7,14,0.94)_58%,#02070e_78%)] lg:bg-[linear-gradient(100deg,#02070e_0%,#02070e_27%,rgba(2,7,14,0.93)_36%,rgba(2,7,14,0.6)_45%,rgba(2,7,14,0.2)_56%,transparent_67%)]"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 hidden h-40 bg-[linear-gradient(to_top,#02070e_0%,rgba(2,7,14,0.6)_45%,transparent_100%)] lg:block"
        aria-hidden
      />

      <div className="hero-shell shell relative pb-14 pt-[116px] lg:pb-[46px] lg:pt-[150px]">
        <div className="max-w-[560px] lg:max-w-[620px]">
          {/* Eyebrow badge */}
          <div className="rise">
            <div className="inline-flex items-center gap-2.5 rounded-full border border-white/[0.09] bg-[#131a2c]/75 py-[9px] pl-4 pr-5 backdrop-blur-sm">
              <SparkleIcon className="h-[17px] w-[17px] text-[#8b93f2]" />
              <span className="text-[13px] font-semibold uppercase tracking-[0.13em] text-[#c3cad9]">
                AI Revenue Recovery Agent
              </span>
            </div>
          </div>

          {/* Headline */}
          <div className="rise" style={{ animationDelay: "90ms" }}>
          <h1 className="mt-8 font-display text-[clamp(46px,7vw,98px)] leading-[0.96] tracking-[-0.005em] [text-shadow:0_2px_18px_rgba(2,7,14,0.55)]">
            <span className="block text-cream">We bring</span>
            <span className="block text-cream">your revenue</span>
            <span className="block text-gold-500">back home.</span>
          </h1>
          </div>

          <div className="rise" style={{ animationDelay: "190ms" }}>
          <p className="mt-8 max-w-[500px] text-[18px] leading-[1.7] text-[#a9b3c2]">
            Tugboat (Boa) detects revenue at risk, diagnoses the root cause, and executes the right
            recovery workflow&mdash;across failed payments, abandoned checkouts, bounced mandates,
            and overdue invoices.
          </p>
          </div>

          <div className="rise mt-9" style={{ animationDelay: "290ms" }}>
            <Link href="/login" className="btn-gold group gap-5 px-7 py-[15px] text-[16px]">
              See Tugboat in action
              <ArrowRightIcon className="h-[20px] w-[20px] transition-transform group-hover:translate-x-0.5" />
            </Link>
          </div>
        </div>

        {/* Trust strip */}
        <div className="rise mt-14 lg:mt-[48px]" style={{ animationDelay: "380ms" }}>
          <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:flex sm:flex-wrap sm:items-center sm:gap-y-4">
            {TRUST.map(({ label, Icon, tinted }, i) => (
              <div key={label} className="flex items-center">
                {i > 0 ? (
                  <span className="mr-7 hidden h-[30px] w-px bg-white/[0.09] lg:mr-9 lg:block" aria-hidden />
                ) : null}
                <span className="mr-3.5 flex h-[26px] w-[26px] shrink-0 items-center justify-center">
                  <Icon className={tinted ? "h-[26px] w-[26px]" : "h-[25px] w-[25px] text-[#9aa5b4]"} />
                </span>
                <span className="text-[15px] font-medium text-[#c2cad6] sm:mr-7 lg:mr-9">{label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
