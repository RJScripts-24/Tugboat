import { BoaStats } from "@/components/landing/boa-stats";
import { Hero } from "@/components/landing/hero";
import { SiteHeader } from "@/components/landing/site-header";
import { WhatTugboatDoes } from "@/components/landing/what-tugboat-does";

/**
 * The landing page (PRD 6.3, page 9).
 *
 * The "Trusted by forward-thinking merchants" wall of Razorpay, UPI, RuPay,
 * WhatsApp, Twilio and AWS wordmarks was removed rather than reworded. Those
 * are real companies and none of them endorses this; the marks were there
 * because they look like credibility, which is the exact reason they had to
 * go. The integrations they stood for are still stated where they are true and
 * checkable - each channel names its provider and its mode on the Policies
 * page.
 */
export default function LandingPage() {
  return (
    <>
      <SiteHeader />
      <main>
        <Hero />
        <WhatTugboatDoes />
        <BoaStats />
      </main>
    </>
  );
}
