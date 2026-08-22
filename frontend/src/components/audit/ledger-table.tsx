"use client";

import Link from "next/link";
import { useCallback, useState } from "react";

import { ChalkRule } from "@/components/dashboard/chalk";
import {
  ChainIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  ExternalLinkIcon,
} from "@/components/dashboard/icons";
import { preciseStampOf } from "@/lib/clock";
import { ACTOR_META, type LedgerRow } from "@/lib/audit-data";
import { verifyRow } from "@/lib/ledger-verify";
import { PayloadView } from "./payload-view";

/**
 * The ledger, as a table (PRD 6.3, page 8).
 *
 * Read-only, and not in the weak sense of "we did not build the edit button".
 * There is no affordance on this page that mutates a row, no bulk action, no
 * status a person can set - the only interactions are looking closer, copying
 * a digest, and following a row back to the case it came from. A log a
 * merchant can edit is a log that proves nothing about the merchant.
 *
 * Expansion is where the page earns its place: the payload with its masked
 * fields marked, and beside it the row's own working - the digest preimage,
 * the digest recomputed in the browser from that preimage, and whether the two
 * agree. A reader does not have to take the tick on faith; the arithmetic is
 * on the screen.
 */
export function LedgerTable({
  rows,
  index,
  /** Rows the verifier flagged, by id, with the reason. */
  broken,
  tamperedId,
}: {
  rows: LedgerRow[];
  index: Record<string, { label: string; cause: string; stage: string }>;
  broken: Record<string, string>;
  /** The row the tamper demo pretended to edit, if that demo is running. */
  tamperedId: string | null;
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());

  const toggle = useCallback((id: string) => {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return (
    <div className="overflow-x-auto">
      <table className="optable">
        <thead>
          <tr>
            <th className="w-[10px]" />
            <th>Time · IST</th>
            <th>Entry hash</th>
            <th>Actor</th>
            <th>Action</th>
            <th>Case</th>
            <th className="w-full">Detail</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <Row
              key={row.id}
              row={row}
              context={row.caseId ? index[row.caseId] : undefined}
              expanded={open.has(row.id)}
              onToggle={toggle}
              brokenReason={broken[row.id]}
              tampered={tamperedId === row.id}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Row({
  row,
  context,
  expanded,
  onToggle,
  brokenReason,
  tampered,
}: {
  row: LedgerRow;
  context?: { label: string; cause: string; stage: string };
  expanded: boolean;
  onToggle: (id: string) => void;
  brokenReason?: string;
  tampered: boolean;
}) {
  const stamp = preciseStampOf(row.atMs);
  const actor = ACTOR_META[row.actor];

  return (
    <>
      <tr
        className="cursor-pointer"
        data-broken={brokenReason ? true : undefined}
        onClick={() => onToggle(row.id)}
      >
        <td className="pr-0">
          <ChevronDownIcon
            className={`h-[11px] w-[11px] text-txt-faint transition-transform ${
              expanded ? "rotate-180" : "-rotate-90"
            }`}
          />
        </td>

        <td className="mono text-[11.5px] text-txt-faint">
          <span className="text-txt-dim">{stamp.day}</span> {stamp.time}
        </td>

        <td>
          <span className="mono inline-flex items-center gap-1.5 text-[11.5px] text-txt-dim">
            <ChainIcon
              className="h-[11px] w-[11px] shrink-0 text-txt-faint opacity-70"
              // The previous digest is the link, so the link icon is where it
              // belongs rather than in a column nobody has room for.
            />
            <span title={`links to ${row.prevHash}`}>{row.hash}</span>
          </span>
        </td>

        <td>
          <span
            className="mono text-[10.5px] uppercase tracking-[0.06em]"
            style={{ color: actor.hex }}
          >
            {row.actor}
          </span>
        </td>

        <td className="mono text-[11.5px] text-txt-dim">{row.action}</td>

        <td className="mono text-[11.5px]">
          {row.caseId ? (
            <span className="text-txt-dim">{row.caseId}</span>
          ) : (
            <span className="text-txt-faint">policy pack</span>
          )}
        </td>

        <td className="max-w-0">
          <span className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-txt-dim" title={row.detail}>
              {row.detail}
            </span>
            {row.masked.length > 0 ? (
              <span className="mono shrink-0 text-[10px] uppercase tracking-[0.06em] text-waiting opacity-75">
                masked
              </span>
            ) : null}
            {brokenReason ? (
              <span className="mono shrink-0 text-[10px] uppercase tracking-[0.06em] text-halted">
                {tampered ? "edited" : "chain broken"}
              </span>
            ) : null}
          </span>
        </td>
      </tr>

      {expanded ? (
        <tr className="expanded-row">
          <td colSpan={7} className="px-0 py-0">
            <Detail row={row} context={context} brokenReason={brokenReason} tampered={tampered} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ */

function Detail({
  row,
  context,
  brokenReason,
  tampered,
}: {
  row: LedgerRow;
  context?: { label: string; cause: string; stage: string };
  brokenReason?: string;
  tampered: boolean;
}) {
  const check = verifyRow(row);

  return (
    <div className="grid grid-cols-1 gap-x-6 gap-y-4 border-l-2 border-white/15 bg-black/25 px-5 py-4 xl:grid-cols-[1.25fr_1fr]">
      <div className="min-w-0">
        <p className="chalk-hand mb-2 text-[13px] uppercase tracking-[0.07em] text-txt-faint">
          Payload as stored
        </p>
        <PayloadView value={row.payload} masked={row.masked} />

        {row.masked.length > 0 ? (
          <p className="mt-3 max-w-[64ch] text-[11px] leading-[1.6] text-txt-faint">
            {row.masked.length === 1 ? "One field was" : `${row.masked.length} fields were`} masked
            before this row was written, not on the way to this screen. The model that planned this
            action received the masked value too (PRD 9.9).
          </p>
        ) : null}
      </div>

      <div className="min-w-0">
        <p className="chalk-hand mb-2 text-[13px] uppercase tracking-[0.07em] text-txt-faint">
          Chain
        </p>

        <dl className="space-y-[7px]">
          <Fact label="Chain" value={row.chain} />
          <Fact label="Sequence" value={`#${row.seq}`} />
          <Fact label="Digest" value={row.hash} copyable />
          <Fact label="Previous" value={row.prevHash} copyable />
        </dl>

        <ChalkRule className="my-3" />

        {/* The working, shown. A tick a reader cannot check is decoration. */}
        <p className="chalk-hand mb-1.5 text-[13px] uppercase tracking-[0.07em] text-txt-faint">
          Recomputed here, in your browser
        </p>
        <p className="mono break-all text-[11px] leading-[1.6] text-txt-faint">
          digest( <span className="text-txt-dim">{tampered ? `${row.seed}|EDITED` : row.seed}</span>{" "}
          | <span className="text-txt-dim">{row.prevHash}</span> )
        </p>
        <p className="mono mt-1.5 flex flex-wrap items-center gap-2 text-[11.5px]">
          <span className="text-txt-faint">=</span>
          <span className={brokenReason ? "text-halted" : "text-txt"}>
            {tampered ? "—" : check.digest}
          </span>
          {brokenReason ? (
            <span className="text-[10.5px] uppercase tracking-[0.07em] text-halted">
              does not match
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-[10.5px] uppercase tracking-[0.07em] text-txt-dim">
              <CheckIcon className="h-[9px] w-[9px]" />
              matches the stored digest
            </span>
          )}
        </p>

        {brokenReason ? (
          <p className="mt-2.5 border-l-2 border-halted pl-3 text-[11.5px] leading-[1.6] text-halted">
            {brokenReason}
          </p>
        ) : null}

        {row.caseId ? (
          <>
            <ChalkRule className="my-3" />
            <p className="text-[11.5px] leading-[1.6] text-txt-faint">
              {context
                ? `${context.label} · ${context.cause} · now ${context.stage}`
                : "Case context unavailable"}
            </p>
            <Link href={`/cases/${row.caseId}`} className="disclose mt-1.5 inline-flex">
              Open {row.caseId} and see this row on the timeline
              <ExternalLinkIcon className="h-[11px] w-[11px]" />
            </Link>
          </>
        ) : (
          <>
            <ChalkRule className="my-3" />
            <Link href="/policies" className="disclose mt-1 inline-flex">
              Open the policy pack this revision changed
              <ExternalLinkIcon className="h-[11px] w-[11px]" />
            </Link>
          </>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Fact({
  label,
  value,
  copyable = false,
}: {
  label: string;
  value: string;
  copyable?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_200);
    } catch {
      // Clipboard is permission-gated; the value is on screen either way.
    }
  };

  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-[11.5px] text-txt-faint">{label}</dt>
      <dd className="mono min-w-0 text-right text-[11.5px] text-txt-dim">
        {copyable ? (
          <button
            type="button"
            onClick={copy}
            className="group inline-flex items-center gap-1.5 transition-colors hover:text-txt"
          >
            {copied ? "copied" : value}
            <CopyIcon className="h-[10px] w-[10px] opacity-0 transition-opacity group-hover:opacity-60" />
          </button>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}
