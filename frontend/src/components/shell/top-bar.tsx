"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { SignOutIcon } from "@/components/dashboard/icons";
import { ChalkRule } from "@/components/dashboard/chalk";
import { NAV, titleFor } from "./nav";

/**
 * Page title, environment, clock, operator (PRD 6.2).
 *
 * The "Test mode" tag is not decoration: it is the standing disclosure that
 * every payment action on screen hit a real Razorpay test-mode endpoint rather
 * than a mock, which is exactly the distinction a payments panel will ask about.
 */
export function TopBar({
  merchantName,
  pendingApprovals,
  policyVersion,
}: {
  merchantName: string;
  pendingApprovals: number;
  policyVersion: string;
}) {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-30 bg-[var(--slate-base)]">
      <div className="flex h-[68px] items-center gap-3.5 px-4 sm:px-5">
        <Link href="/dashboard" className="shrink-0 lg:hidden" aria-label="Tugboat Control Tower">
          <Image
            src="/media/tugboat-mark.png"
            alt=""
            width={128}
            height={128}
            className="h-[34px] w-[34px]"
          />
        </Link>

        <h1 className="chalk-hand chalk-strong truncate text-[26px] uppercase tracking-[0.06em] text-txt">
          {titleFor(pathname)}
        </h1>

        <span className="hidden items-center gap-1.5 rounded-[2px] border border-[rgba(232,227,214,0.12)] px-2 py-[3px] sm:inline-flex">
          <span className="h-[5px] w-[5px] rounded-[1px] bg-diagnosis" aria-hidden />
          <span className="chalk-hand text-[12px] uppercase tracking-[0.07em] text-txt-dim">
            Razorpay test mode
          </span>
        </span>

        <span className="mono hidden text-[11px] text-txt-faint xl:inline">
          policy {policyVersion}
        </span>

        <div className="ml-auto flex items-center gap-3">
          <LiveClock />

          <div className="flex items-center gap-2 border-l border-[rgba(232,227,214,0.09)] pl-3">
            <span
              className="flex h-[27px] w-[27px] items-center justify-center rounded-[3px] border border-[rgba(232,227,214,0.14)] text-[11px] font-semibold text-txt-dim"
              aria-hidden
            >
              DM
            </span>
            <span className="hidden text-[13px] text-txt-dim md:inline">{merchantName}</span>
            <form action="/api/auth/logout" method="post">
              <button
                type="submit"
                aria-label="Sign out"
                title="Sign out"
                className="rounded-[3px] p-1.5 text-txt-faint transition-colors hover:text-txt focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-waiting"
              >
                <SignOutIcon className="h-[16px] w-[16px]" />
              </button>
            </form>
          </div>
        </div>
      </div>

      <ChalkRule />

      {/* The rail, folded into a strip on narrow screens */}
      <nav className="scroll-thin flex gap-4 overflow-x-auto px-4 lg:hidden">
        {NAV.map(({ href, label, badge }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={`nav-label relative shrink-0 py-2.5 text-[13.5px] transition-colors ${
                active ? "font-medium text-txt" : "text-txt-dim hover:text-txt"
              }`}
            >
              {label}
              {badge === "approvals" && pendingApprovals > 0 ? (
                <span className="mono ml-1.5 text-[11px] text-waiting">{pendingApprovals}</span>
              ) : null}
              {active ? (
                <span className="chalk-rule absolute inset-x-0 bottom-[3px]" aria-hidden />
              ) : null}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}

/**
 * IST, ticking. Renders a placeholder until mounted: the server has no idea
 * what second it is on the client, and a mismatch here would be a hydration
 * error on every page load.
 */
function LiveClock() {
  const [now, setNow] = useState<string | null>(null);

  useEffect(() => {
    const format = () =>
      new Intl.DateTimeFormat("en-IN", {
        timeZone: "Asia/Kolkata",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(new Date());

    setNow(format());
    const id = setInterval(() => setNow(format()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <span className="mono hidden text-[12px] text-txt-faint sm:inline">
      {now ?? "--:--:--"} IST
    </span>
  );
}
