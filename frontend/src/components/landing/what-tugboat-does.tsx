import type { ComponentType, SVGProps } from "react";
import {
  BarChartIcon,
  MagnifierIcon,
  PaperPlaneIcon,
  RadarIcon,
  StrategyIcon,
} from "./icons";
import { Reveal, RevealItem } from "./reveal";

type Stage = {
  n: string;
  title: string;
  body: string;
  accent: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** How hard the icon glows — filled marks need less than line marks. */
  glow: string;
};

const STAGES: Stage[] = [
  {
    n: "01",
    title: "Detect",
    body: "Spot revenue at risk in real time across payments, checkouts, mandates & invoices.",
    accent: "#7b7bf5",
    Icon: RadarIcon,
    glow: "drop-shadow(0 0 14px rgba(123,123,245,0.55))",
  },
  {
    n: "02",
    title: "Diagnose",
    body: "AI figures out the root cause — bank issues, user intent, insufficient funds & more.",
    accent: "#f0596a",
    Icon: MagnifierIcon,
    glow: "drop-shadow(0 0 14px rgba(240,89,106,0.55))",
  },
  {
    n: "03",
    title: "Decide",
    body: "Chooses the right intervention at the right time with strict rules and guardrails.",
    accent: "#4ade80",
    Icon: StrategyIcon,
    glow: "drop-shadow(0 0 14px rgba(74,222,128,0.5))",
  },
  {
    n: "04",
    title: "Execute",
    body: "Sends WhatsApp, Email, Voice (Hinglish), SMS or retries — all bounded & compliant.",
    accent: "#4a90f0",
    Icon: PaperPlaneIcon,
    glow: "drop-shadow(0 0 16px rgba(74,144,240,0.45))",
  },
  {
    n: "05",
    title: "Measure",
    body: "Track recovery, costs, escalations and audit every action with complete transparency.",
    accent: "#f0ac2a",
    Icon: BarChartIcon,
    glow: "drop-shadow(0 0 16px rgba(240,172,42,0.45))",
  },
];

export function WhatTugboatDoes() {
  return (
    <section
      id="how-it-works"
      className="relative bg-[linear-gradient(180deg,#050f1a_0%,#06111d_38%,#050e19_100%)] pb-16 pt-16 lg:pb-[45px] lg:pt-[38px]"
    >
      <div className="shell">
        <Reveal>
        <header className="text-center">
          <p className="text-[14px] font-semibold uppercase tracking-[0.3em] text-[#6b79ee]">
            What Tugboat Does
          </p>
          <h2 className="mx-auto mt-3 max-w-[880px] text-[clamp(27px,3.4vw,38px)] font-extrabold leading-[1.16] tracking-[-0.02em] text-white">
            Recover more. Automatically. Compliantly.
          </h2>
          <p className="mx-auto mt-1.5 max-w-[860px] text-[18.5px] leading-[1.6] text-[#94a0b1]">
            End-to-end revenue recovery agent that closes the loop and proves every rupee recovered.
          </p>
        </header>
        </Reveal>

        <ul className="mt-10 grid grid-cols-1 gap-[22px] sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 lg:mt-[26px]">
          {STAGES.map(({ n, title, body, accent, Icon, glow }, i) => (
            <RevealItem
              key={n}
              delay={i * 90}
              className="group relative overflow-hidden rounded-[16px] border p-[20px]"
              style={{
                borderColor: `color-mix(in srgb, ${accent} 26%, transparent)`,
                background: `radial-gradient(120% 78% at 50% 0%, color-mix(in srgb, ${accent} 9%, transparent) 0%, transparent 62%), linear-gradient(180deg, #060f1c 0%, #040b16 100%)`,
              }}
            >
              <div className="flex h-[96px] items-center justify-center">
                <Icon
                  className="h-[90px] w-[90px]"
                  style={{ color: accent, filter: glow }}
                />
              </div>

              <div className="mt-3 flex items-center gap-3">
                <span
                  className="tabular flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full border text-[13px] font-semibold"
                  style={{
                    borderColor: `color-mix(in srgb, ${accent} 45%, transparent)`,
                    color: accent,
                  }}
                >
                  {n}
                </span>
                <h3 className="text-[21px] font-bold tracking-[-0.015em] text-white">{title}</h3>
              </div>

              <p className="mt-3.5 text-[14px] leading-[1.78] text-[#93a0b0]">{body}</p>
            </RevealItem>
          ))}
        </ul>
      </div>
    </section>
  );
}
