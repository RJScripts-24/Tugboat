import Image from "next/image";
import Link from "next/link";
import type { ComponentType, SVGProps } from "react";

import { formatPercent, formatRupeesCompact } from "@/lib/money";
import { getGrading, getHeadline } from "@/lib/simulation-data";
import { ClockIcon, RupeeCircleIcon, ShieldSolidIcon, UsersSolidIcon } from "./icons";
import { Reveal } from "./reveal";

type Stat = {
  value: string;
  label: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  tone: string;
};

/**
 * Four numbers, and every one of them checkable.
 *
 * This row used to read "₹3.24 Cr+ recovered · 32,841 cases · 3,200 merchants
 * trust Tugboat · 99.9% uptime". None of that was true. Tugboat has no
 * merchants, no production traffic and no uptime history, and a panel from a
 * payments company is precisely the audience most likely to ask for the
 * source - at which point every real number on the site becomes suspect too.
 *
 * What replaces them is the pinned evidence run: the same seeded batch the
 * Simulation Lab reports, read from the same module, so the landing page
 * cannot drift from the report behind it. A visitor can rerun the seed and get
 * these figures back.
 */
function stats(): Stat[] {
  const headline = getHeadline();
  const grading = getGrading();

  return [
    {
      value: formatPercent(headline.recoveryRate),
      label: "Of at-risk revenue recovered",
      Icon: RupeeCircleIcon,
      tone: "#8b8bf5",
    },
    {
      value: `+${headline.upliftPoints.toFixed(1)} pts`,
      label: "Uplift over the same batch, agent off",
      Icon: ShieldSolidIcon,
      tone: "#4a90f0",
    },
    {
      value: formatPercent(grading.accuracy),
      label: "Diagnoses correct vs ground truth",
      Icon: UsersSolidIcon,
      tone: "#8b8bf5",
    },
    {
      value: `₹${formatRupeesCompact(headline.atRiskPaise)}`,
      label: "At risk in the batch measured",
      Icon: ClockIcon,
      tone: "#8b8bf5",
    },
  ];
}

export function BoaStats() {
  const headline = getHeadline();
  const STATS = stats();

  return (
    <section id="product" className="relative bg-[#050e19] pb-14 lg:pb-[52px]">
      <div className="shell">
        <div className="grid items-center gap-10 lg:grid-cols-[400px_1fr] lg:gap-[36px]">
          {/* Boa */}
          <Reveal className="flex items-center gap-6">
            <div className="relative shrink-0">
              <div
                className="absolute -inset-2 rounded-full bg-[radial-gradient(circle,rgba(240,172,42,0.18)_0%,transparent_70%)]"
                aria-hidden
              />
              <Image
                src="/media/boa-avatar.png"
                alt="Boa, the Tugboat agent, at the wheel"
                width={360}
                height={360}
                className="relative h-[120px] w-[120px] rounded-full ring-1 ring-white/[0.07] lg:h-[158px] lg:w-[158px]"
              />
            </div>
            <div className="max-w-[242px]">
              <h2 className="text-[23px] font-extrabold tracking-[-0.015em] text-gold-500">
                Boa is at the wheel.
              </h2>
              <p className="mt-3 text-[15px] leading-[1.78] text-[#8f9aa9]">
                <span className="font-bold text-white">Boa</span> works{" "}
                <span className="font-medium text-[#7f9df0] underline decoration-[#7f9df0]/60 underline-offset-[3px]">
                  24×7
                </span>{" "}
                to tow back revenue that would have drifted away — so merchants can focus on growing
                their business.
              </p>
            </div>
          </Reveal>

          {/* Numbers */}
          <Reveal delay={120} className="rounded-[18px] border border-white/[0.07] bg-white/[0.015] px-4 py-8 lg:px-8 lg:py-8">
            <dl className="grid grid-cols-2 gap-y-9 md:grid-cols-4 md:gap-y-0">
              {STATS.map(({ value, label, Icon, tone }, i) => (
                <div
                  key={label}
                  className={`flex flex-col items-center px-2 text-center ${
                    i > 0 ? "md:border-l md:border-white/[0.07]" : ""
                  }`}
                >
                  <span
                    className="flex h-[50px] w-[50px] items-center justify-center rounded-full border"
                    style={{
                      borderColor: `color-mix(in srgb, ${tone} 40%, transparent)`,
                      color: tone,
                      background: `radial-gradient(circle, color-mix(in srgb, ${tone} 12%, transparent) 0%, transparent 72%)`,
                    }}
                  >
                    <Icon className="h-[26px] w-[26px]" />
                  </span>
                  <dd className="tabular mt-4 text-[clamp(26px,2.8vw,37px)] font-semibold leading-none tracking-[-0.025em] text-white">
                    {value}
                  </dd>
                  <dt className="mt-3 text-[15px] text-[#8b96a6]">{label}</dt>
                </div>
              ))}
            </dl>

            {/* Where the numbers come from, next to the numbers. */}
            <p className="mt-8 text-center text-[13.5px] leading-[1.6] text-[#7d879a] md:mt-7">
              Measured on a pinned evidence run — seed 42, {headline.cases} synthetic cases, graded
              against ground truth. Not production figures: Tugboat has no live merchants yet.{" "}
              <Link
                href="/simulation"
                className="text-[#9aa8bd] underline underline-offset-[3px] transition-colors hover:text-white"
              >
                Rerun the seed and download the report
              </Link>
              .
            </p>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
