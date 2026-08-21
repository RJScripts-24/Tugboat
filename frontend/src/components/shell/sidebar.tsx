"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { ChalkRule } from "@/components/dashboard/chalk";
import { MoneyValue } from "@/components/dashboard/primitives";
import { NAV } from "./nav";

/**
 * The fixed left rail (PRD 6.2).
 *
 * Part of the slate, not a panel floating on it: no fill of its own, a drawn
 * rule for its edge, and labels written in chalk. The supplied logo and the
 * Boa artwork stay exactly as delivered - polished objects resting on the
 * board, which is what makes the board read as a board.
 *
 * Below `lg` it collapses to the strip in the header.
 */
export function Sidebar({
  pendingApprovals,
  recoveredTodayPaise,
  activeCases,
}: {
  pendingApprovals: number;
  recoveredTodayPaise: number;
  activeCases: number;
}) {
  const pathname = usePathname();

  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-[236px] flex-col border-r border-[rgba(232,227,214,0.08)] lg:flex">
      <div className="flex h-[68px] shrink-0 items-center px-4">
        <Link href="/dashboard" aria-label="Tugboat Control Tower">
          <Image
            src="/media/tugboat-logo.png"
            alt="Tugboat"
            width={640}
            height={233}
            priority
            className="h-[46px] w-auto"
          />
        </Link>
      </div>

      <ChalkRule />

      <nav className="flex-1 py-2">
        <ul>
          {NAV.map(({ href, label, Icon, badge }) => {
            const active = pathname === href || pathname.startsWith(`${href}/`);
            return (
              <li key={href}>
                <Link
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={`relative flex items-center gap-3 py-[9px] pl-4 pr-3 text-[13.5px] transition-colors ${
                    active
                      ? "font-medium text-txt"
                      : "text-txt-dim hover:text-txt"
                  }`}
                >
                  {active ? (
                    <span
                      className="chalk-rule absolute bottom-[5px] left-4 right-3"
                      aria-hidden
                    />
                  ) : null}
                  <Icon
                    className={`h-[16px] w-[16px] shrink-0 ${
                      active ? "text-waiting" : "text-txt-faint"
                    }`}
                  />
                  <span className="nav-label">{label}</span>
                  {badge === "approvals" && pendingApprovals > 0 ? (
                    <span className="mono ml-auto text-[11.5px] text-waiting">
                      {pendingApprovals}
                    </span>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Boa as an operator identity, not a mascot: name, role, duty state.
          The avatar is a supplied asset and stays untouched. */}
      <ChalkRule />
      <div className="px-4 py-3.5">
        <div className="flex items-center gap-2.5">
          <Image
            src="/media/boa-avatar.png"
            alt=""
            width={80}
            height={80}
            className="h-[34px] w-[34px] rounded-full"
          />
          <div className="min-w-0">
            <p className="chalk-hand text-[15px] leading-tight text-txt">BOA</p>
            <p className="chalk-hand mt-[2px] text-[12px] leading-tight text-txt-faint">Revenue recovery agent</p>
          </div>
        </div>

        <p className="chalk-hand mt-3 flex items-center gap-2 text-[12.5px] uppercase tracking-[0.09em] text-waiting">
          <span className="pulse-dot h-[6px] w-[6px] rounded-full bg-waiting" aria-hidden />
          On duty
        </p>

        <ChalkRule className="mt-2.5" />
        <dl className="mt-2.5 space-y-1 pt-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <dt className="chalk-hand text-[13px] text-txt-dim">Active cases</dt>
            <dd className="mono text-[12.5px] text-txt">{activeCases}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <dt className="chalk-hand text-[13px] text-txt-dim">Recovered today</dt>
            <dd>
              <MoneyValue paise={recoveredTodayPaise} className="text-[12.5px] text-recovered" />
            </dd>
          </div>
        </dl>
      </div>
    </aside>
  );
}
