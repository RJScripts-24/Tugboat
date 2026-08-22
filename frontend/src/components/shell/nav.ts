import type { ComponentType, SVGProps } from "react";

import {
  ApprovalIcon,
  FlaskIcon,
  LedgerIcon,
  PipelineIcon,
  PolicyIcon,
  TowerIcon,
} from "@/components/dashboard/icons";

export type NavItem = {
  href: string;
  label: string;
  /** Shown in the top bar when this route is active. */
  title: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** Approvals carries the live pending count. */
  badge?: "approvals";
};

/** The shell's nav, in the order the PRD lists it (6.2). */
export const NAV: NavItem[] = [
  { href: "/dashboard", label: "Control Tower", title: "Control Tower", Icon: TowerIcon },
  { href: "/cases", label: "Pipeline", title: "Recovery Pipeline", Icon: PipelineIcon },
  {
    href: "/approvals",
    label: "Approvals",
    title: "Approvals Queue",
    Icon: ApprovalIcon,
    badge: "approvals",
  },
  { href: "/simulation", label: "Simulation Lab", title: "Simulation Lab", Icon: FlaskIcon },
  { href: "/audit", label: "Audit", title: "Audit Explorer", Icon: LedgerIcon },
  { href: "/policies", label: "Policies", title: "Policies & Guardrails", Icon: PolicyIcon },
];

export function titleFor(pathname: string): string {
  // One case is not the pipeline. The rail still highlights Pipeline, because
  // that is where the case lives, but the heading has to name the page you are
  // actually on or it reads as a stale header.
  if (/^\/cases\/[^/]+$/.test(pathname)) return "Case Detail";

  const match = NAV.find(
    (item) => pathname === item.href || pathname.startsWith(`${item.href}/`),
  );
  return match?.title ?? "Control Tower";
}
