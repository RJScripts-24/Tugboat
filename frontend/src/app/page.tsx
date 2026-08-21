import { BoaStats } from "@/components/landing/boa-stats";
import { Hero } from "@/components/landing/hero";
import { SiteHeader } from "@/components/landing/site-header";
import { TrustedBy } from "@/components/landing/trusted-by";
import { WhatTugboatDoes } from "@/components/landing/what-tugboat-does";

export default function LandingPage() {
  return (
    <>
      <SiteHeader />
      <main>
        <Hero />
        <WhatTugboatDoes />
        <BoaStats />
        <TrustedBy />
      </main>
    </>
  );
}
