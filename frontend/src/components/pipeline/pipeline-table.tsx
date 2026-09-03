"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ComponentType, ReactNode, SVGProps } from "react";

import {
  CardIcon,
  CartIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  InvoiceIcon,
  MandateIcon,
} from "@/components/dashboard/icons";
import { MoneyValue, StatusMark } from "@/components/dashboard/primitives";
import {
  CASE_TYPE_META,
  formatAge,
  stageBadgeOf,
  type CaseType,
  type PipelineCase,
} from "@/lib/pipeline-data";
import type { HrefPatch, Sort, SortKey } from "./filters";

const TYPE_ICON: Record<CaseType, ComponentType<SVGProps<SVGSVGElement>>> = {
  PAYMENT_FAILED: CardIcon,
  CHECKOUT_ABANDONED: CartIcon,
  MANDATE_FAILED: MandateIcon,
  INVOICE_OVERDUE: InvoiceIcon,
};

/**
 * The working list (PRD 6.3, page 3).
 *
 * Nine columns, and each one answers a question an operator would otherwise
 * have to open the case to ask: what is it, whose money, how much, what did Boa
 * conclude and how sure was it, where has it got to, what happens next, how
 * much rope is left, and how stale is any of this.
 *
 * Two of them are quietly load-bearing. The confidence figure beside the root
 * cause carries the diagnosis method, so the deterministic-first design (ADR-5)
 * is auditable by hovering. The attempts column is the bounded workflow in its
 * smallest possible form: 3/3 means Boa is done with that customer whether or
 * not the money came back.
 */
export function PipelineTable({
  rows,
  sort,
  buildHref,
  flashed,
  highlighted,
}: {
  rows: PipelineCase[];
  sort: Sort;
  buildHref: (patch: HrefPatch) => string;
  /** Cases whose stage just changed under the operator. */
  flashed: Set<string>;
  /** Arrived here from a link that named one case. */
  highlighted: string | null;
}) {
  const router = useRouter();

  return (
    // `relative`, so absolute descendants (the sr-only header label) position
    // inside this scrollbox instead of against the document — without it the
    // hidden span lands past the viewport and widens the whole page on phones.
    <div className="scroll-thin relative overflow-x-auto">
      <table className="optable">
        <thead>
          <tr>
            <SortableHeader column="id" sort={sort} buildHref={buildHref}>
              Case
            </SortableHeader>
            <th>Type</th>
            <SortableHeader column="customer" sort={sort} buildHref={buildHref}>
              Customer
            </SortableHeader>
            <SortableHeader column="amount" sort={sort} buildHref={buildHref} align="right">
              Amount
            </SortableHeader>
            <th>Root cause</th>
            <th>Stage</th>
            <th>Next action</th>
            <SortableHeader column="attempts" sort={sort} buildHref={buildHref} align="right">
              Attempts
            </SortableHeader>
            <SortableHeader column="activity" sort={sort} buildHref={buildHref}>
              Last activity
            </SortableHeader>
            <th>
              <span className="sr-only">Open case</span>
            </th>
          </tr>
        </thead>

        <tbody>
          {rows.map((row) => {
            const stage = stageBadgeOf(row);
            const Icon = TYPE_ICON[row.type];
            const capped = row.attempts >= row.attemptCap;
            const low = row.confidence !== null && row.confidence < 0.6;

            return (
              <tr
                key={row.id}
                // The row is a click target for the mouse; the case id beside it
                // is the real link, which is what keyboards and middle-clicks
                // use. Nothing here is reachable only by clicking a <tr>.
                onClick={(event) => {
                  if ((event.target as HTMLElement).closest("a")) return;
                  router.push(`/cases/${row.id}`);
                }}
                className={`group cursor-pointer ${flashed.has(row.id) ? "row-flash " : ""}${
                  highlighted === row.id ? "bg-white/[0.05]" : ""
                }`}
              >
                <td>
                  <Link
                    href={`/cases/${row.id}`}
                    className="mono text-txt underline-offset-2 hover:underline"
                  >
                    {row.id}
                  </Link>
                </td>

                <td>
                  <span className="flex items-center gap-2 text-txt-dim">
                    <Icon className="h-[14px] w-[14px] shrink-0 opacity-70" />
                    {CASE_TYPE_META[row.type].short}
                  </span>
                </td>

                <td>
                  <span className="text-txt">{row.customer}</span>
                  <span className="mono ml-2 text-[11px] text-txt-faint">{row.contact}</span>
                </td>

                <td className="num">
                  <MoneyValue paise={row.amountPaise} className="text-txt" />
                </td>

                <td
                  title={
                    row.confidence === null
                      ? "Queued for diagnosis"
                      : `confidence ${row.confidence.toFixed(2)} · ${
                          row.method === "LLM" ? "diagnosed by LLM" : "diagnosed by rules table"
                        }`
                  }
                >
                  {row.confidence === null ? (
                    <span className="text-[11.5px] italic text-txt-faint">awaiting diagnosis</span>
                  ) : (
                    <>
                      {/* Deliberately uncoloured. The palette's colours mean
                          stage - green recovered, amber waiting, red halted -
                          and spending them on root causes too would leave two
                          columns saying different things in the same language. */}
                      <span className="mono text-[11.5px] text-txt-dim">{row.rootCause}</span>
                      <span
                        className={`mono ml-2 text-[11px] ${low ? "text-halted" : "text-txt-faint"}`}
                      >
                        {row.confidence.toFixed(2)}
                      </span>
                    </>
                  )}
                </td>

                <td>
                  <StatusMark tone={stage.tone} pulsing={stage.pulsing}>
                    {stage.label}
                  </StatusMark>
                </td>

                <td className="max-w-[210px] truncate text-txt-dim">{row.nextAction}</td>

                <td className="num">
                  <span className={`mono ${capped ? "text-halted" : "text-txt-dim"}`}>
                    {row.attempts}/{row.attemptCap}
                  </span>
                </td>

                <td className="mono text-[11.5px] text-txt-faint">
                  {formatAge(row.updatedMinutesAgo)}
                </td>

                {/*
                  The row has always been clickable, but a pointer cursor is
                  not an affordance anyone can see - people were reading the
                  table as a dead list. This says where the click goes, and it
                  gives keyboards and middle-clicks a real target at the end of
                  the row rather than only the id at the start of it.
                */}
                <td className="num">
                  <Link
                    href={`/cases/${row.id}`}
                    aria-label={`Open case ${row.id}`}
                    className="disclose ml-auto whitespace-nowrap group-hover:text-txt"
                  >
                    Open
                    <ChevronRightIcon className="h-[11px] w-[11px]" />
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * A sortable heading.
 *
 * First click sorts ascending, clicking the active column flips it - and
 * because sort lives in the URL like everything else here, a sorted view is a
 * shareable one.
 */
function SortableHeader({
  column,
  sort,
  buildHref,
  align = "left",
  children,
}: {
  column: SortKey;
  sort: Sort;
  buildHref: (patch: HrefPatch) => string;
  align?: "left" | "right";
  children: ReactNode;
}) {
  const active = sort.key === column;
  const dir = active && sort.dir === "asc" ? "desc" : "asc";

  return (
    <th
      className={align === "right" ? "num" : undefined}
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <Link
        href={buildHref({ sort: column, dir })}
        scroll={false}
        className={`inline-flex items-center gap-1 transition-colors hover:text-txt ${
          align === "right" ? "flex-row-reverse" : ""
        } ${active ? "text-txt" : ""}`}
      >
        {children}
        <ChevronDownIcon
          className={`h-[10px] w-[10px] transition-transform ${
            active ? (sort.dir === "asc" ? "" : "rotate-180") : "opacity-0"
          }`}
        />
      </Link>
    </th>
  );
}
