import { Architects_Daughter } from "next/font/google";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { ChalkFilters } from "@/components/dashboard/chalk";
import { getPendingApprovalCount } from "@/lib/approvals-data";
import { Sidebar } from "@/components/shell/sidebar";
import { TopBar } from "@/components/shell/top-bar";
import { getShellStatus } from "@/lib/dashboard-data";
import { DEMO_MERCHANT } from "@/lib/demo-merchant";
import { SESSION_COOKIE, signInModeOf } from "@/lib/session";

/**
 * A drafting hand, not a school one - this face is used only for annotations
 * beside the data. Declared here rather than in the root layout so the landing
 * page never pays for a font it does not use.
 */
const chalkHand = Architects_Daughter({
  variable: "--font-chalk",
  weight: "400",
  subsets: ["latin"],
  display: "swap",
});

/**
 * The global shell (PRD 6.2) and the session gate for everything behind it.
 *
 * One guard here rather than one per page: a route that forgets to check is a
 * route that leaks, and the group boundary is the natural place to make that
 * impossible.
 */
export default async function ControlTowerLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = (await cookies()).get(SESSION_COOKIE);
  if (!signInModeOf(session?.value)) redirect("/login");

  const status = getShellStatus();
  // Counted from the queue rather than carried beside it: the badge and the
  // Approvals page have to be the same number or neither is worth showing.
  const pendingApprovals = getPendingApprovalCount();

  return (
    <div className={`slate chalk min-h-svh ${chalkHand.variable}`}>
      <ChalkFilters />

      <Sidebar
        pendingApprovals={pendingApprovals}
        recoveredTodayPaise={status.recoveredTodayPaise}
        activeCases={status.activeCases}
      />

      <div className="lg:pl-[236px]">
        <TopBar
          merchantName={DEMO_MERCHANT.displayName}
          pendingApprovals={pendingApprovals}
          policyVersion={status.policyVersion}
        />
        <main className="px-4 pb-10 pt-4 sm:px-5">{children}</main>
      </div>
    </div>
  );
}
