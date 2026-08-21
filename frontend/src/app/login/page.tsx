import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

import { AuthBackdrop } from "@/components/auth/auth-backdrop";
import { AuthCard } from "@/components/auth/auth-card";

export const metadata: Metadata = {
  title: "Sign in — Tugboat",
  description: "Sign in to the Tugboat Control Tower. Demo merchant, Razorpay test mode.",
  robots: { index: false, follow: false },
};

/**
 * Deliberately static. The "already signed in, go to the dashboard" redirect
 * lives in middleware so this page carries no request-time work and the router
 * can prefetch it from the landing page.
 */
export default function LoginPage() {
  return (
    <main
      className="auth-page relative isolate flex flex-col items-center justify-center px-5"
      style={{ paddingTop: "var(--auth-pad)", paddingBottom: "var(--auth-pad)" }}
    >
      <AuthBackdrop />

      <div className="auth-brand flex flex-col items-center">
        <Link href="/" aria-label="Tugboat home" className="shrink-0">
          <Image
            src="/media/tugboat-logo.png"
            alt="Tugboat"
            width={640}
            height={233}
            priority
            className="w-auto"
            style={{ height: "var(--auth-logo)" }}
          />
        </Link>
        <p
          className="text-[12px] font-semibold uppercase tracking-[0.26em] text-[#7c879a]"
          style={{ marginTop: "calc(var(--auth-gap) * 0.6)", marginBottom: "var(--auth-gap)" }}
        >
          Tows lost revenue home
        </p>
      </div>

      <AuthCard />

      {/* Sits over the tide, so it needs more contrast than a footnote usually would. */}
      <p
        className="auth-footnote max-w-[400px] text-center text-[12.5px] leading-[1.6] text-[#77839a]"
        style={{ marginTop: "var(--auth-gap)" }}
      >
        Every action taken inside is bounded, policy-checked and written to an append-only audit
        ledger.
      </p>
    </main>
  );
}
