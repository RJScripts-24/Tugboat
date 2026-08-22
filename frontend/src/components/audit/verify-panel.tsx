"use client";

import { ChalkNote, ChalkRule } from "@/components/dashboard/chalk";
import { ChainIcon, CheckIcon, HaltIcon, RetryIcon } from "@/components/dashboard/icons";
import { Section } from "@/components/dashboard/primitives";
import type { LedgerRow } from "@/lib/audit-data";
import type { ChainVerdict } from "@/lib/ledger-verify";

export type VerifyState = "idle" | "running" | "done";

export type VerifyResult = ChainVerdict & {
  /** Milliseconds actually spent hashing, not wall-clock across the frames. */
  computeMs: number;
  tamperedId: string | null;
};

/**
 * Chain integrity (PRD 6.3, page 8 - "small feature, disproportionate wow").
 *
 * Two claims, and the panel is built so a sceptic can test both without
 * leaving the page.
 *
 * The first is that the log is verifiable: every digest is recomputed here, in
 * the reader's browser, from the preimage each row carries. Not a status
 * fetched from the server that wrote the hashes.
 *
 * The second is that it is tamper-evident, which is the one nobody believes
 * from a green tick. So the panel will run the same verifier against a
 * hypothetical in which one row's payload was edited, and show what happens:
 * that row fails, and so does every row chained behind it. Nothing is written
 * — the ledger is not touched, and this page has no affordance that could
 * touch it.
 */
export function VerifyPanel({
  state,
  progress,
  result,
  entries,
  target,
  onVerify,
  onTamper,
  onRestore,
}: {
  state: VerifyState;
  /** 0..1 across the chains, for the bar. */
  progress: number;
  result: VerifyResult | null;
  entries: number;
  /** The row the tamper demo would pretend to edit. */
  target: LedgerRow | null;
  onVerify: () => void;
  onTamper: () => void;
  onRestore: () => void;
}) {
  const tampering = result?.tamperedId != null;
  const failed = (result?.broken.length ?? 0) > 0;

  return (
    <Section
      title="Chain integrity"
      action={
        <div className="flex flex-wrap items-center gap-2.5">
          {tampering ? (
            <button type="button" className="btn-op-quiet" onClick={onRestore}>
              <RetryIcon className="h-[12px] w-[12px]" />
              Verify the real ledger again
            </button>
          ) : (
            <button
              type="button"
              className="btn-op-quiet"
              onClick={onTamper}
              disabled={state === "running" || !target}
              title="Runs the verifier against a hypothetical edited row. Nothing is written."
            >
              What if a row were edited?
            </button>
          )}

          <button
            type="button"
            className="btn-op-quiet"
            onClick={onVerify}
            disabled={state === "running"}
          >
            {state === "running" ? (
              <>
                <ChainIcon className="h-[12px] w-[12px] animate-spin" />
                Verifying
              </>
            ) : (
              <>
                <ChainIcon className="h-[12px] w-[12px]" />
                Verify chain
              </>
            )}
          </button>
        </div>
      }
      bodyClassName="px-5 pb-4 pt-3.5"
    >
      {state === "running" ? (
        <Running progress={progress} entries={entries} />
      ) : result ? (
        <Verdict result={result} target={target} failed={failed} tampering={tampering} />
      ) : (
        <Idle entries={entries} />
      )}
    </Section>
  );
}

/* ------------------------------------------------------------------ */

function Idle({ entries }: { entries: number }) {
  return (
    <p className="max-w-[86ch] text-[12px] leading-[1.65] text-txt-dim">
      Every row below carries the exact string its digest was computed from, and the digest of the
      row before it. Press <span className="text-txt">Verify chain</span> and all{" "}
      {entries.toLocaleString("en-IN")} are recomputed here, in this browser, from those preimages —
      nothing is asked of the server that wrote them.
    </p>
  );
}

function Running({ progress, entries }: { progress: number; entries: number }) {
  return (
    <div>
      <p className="mono flex flex-wrap items-baseline justify-between gap-3 text-[12px] text-txt-dim">
        <span>recomputing {entries.toLocaleString("en-IN")} digests</span>
        <span className="tabular text-txt-faint">{Math.round(progress * 100)}%</span>
      </p>
      <div className="mt-2 h-[3px] w-full overflow-hidden rounded-[1px] bg-white/10">
        <div
          className="h-full bg-txt transition-[width] duration-100 ease-linear"
          style={{ width: `${Math.max(2, progress * 100)}%` }}
        />
      </div>
    </div>
  );
}

function Verdict({
  result,
  target,
  failed,
  tampering,
}: {
  result: VerifyResult;
  target: LedgerRow | null;
  failed: boolean;
  tampering: boolean;
}) {
  const chainsHit = new Set(result.broken.map((row) => row.chain)).size;

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-x-5 gap-y-2">
        <p className="flex items-center gap-2.5">
          {failed ? (
            <HaltIcon className="h-[15px] w-[15px] shrink-0 text-halted" />
          ) : (
            <CheckIcon className="h-[14px] w-[14px] shrink-0 text-recovered" />
          )}
          <span
            className={`chalk-hand text-[16px] uppercase tracking-[0.06em] ${
              failed ? "text-halted" : "text-recovered"
            }`}
          >
            {failed
              ? `${result.broken.length} of ${result.checked.toLocaleString("en-IN")} rows fail`
              : `${result.checked.toLocaleString("en-IN")} rows verified`}
          </span>
        </p>

        <p className="mono text-[11.5px] text-txt-faint">
          {result.chains} chains · {result.computeMs.toFixed(1)}ms of hashing
        </p>
      </div>

      {tampering && target ? (
        <>
          <p className="mt-2.5 max-w-[92ch] text-[12px] leading-[1.65] text-txt-dim">
            Hypothetical only — nothing was written. One field of{" "}
            <span className="mono text-txt">{target.chain}</span> row{" "}
            <span className="mono text-txt">#{target.seq}</span> was treated as edited, and the
            verifier was run again over the whole ledger.{" "}
            <span className="text-halted">
              That row and every one of the {result.broken.length - 1} rows chained behind it in{" "}
              {chainsHit === 1 ? "its chain" : `${chainsHit} chains`} now fail
            </span>
            . Changing a row without leaving a trace would mean recomputing every digest after it —
            which is exactly the property an append-only log is supposed to have.
          </p>

          <ChalkRule className="my-3" />

          <ol className="space-y-[5px]">
            {result.broken.slice(0, 6).map((row) => (
              <li key={row.id} className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                <span className="mono shrink-0 text-[11.5px] text-halted">
                  {row.chain} #{row.seq}
                </span>
                <span className="min-w-0 text-[11.5px] leading-[1.55] text-txt-faint">
                  {row.reason}
                </span>
              </li>
            ))}
            {result.broken.length > 6 ? (
              <li className="mono text-[11px] text-txt-faint opacity-75">
                … and {result.broken.length - 6} more, every one of them after the edited row
              </li>
            ) : null}
          </ol>
        </>
      ) : failed ? (
        <p className="mt-2.5 max-w-[86ch] text-[12px] leading-[1.65] text-halted">
          This would be a finding, not a rendering bug. A row whose digest does not reproduce is a
          row that was written differently from how it now reads.
        </p>
      ) : (
        <div className="mt-2.5 flex flex-wrap items-baseline gap-x-4 gap-y-1.5">
          <p className="max-w-[76ch] text-[12px] leading-[1.65] text-txt-dim">
            Each digest covers its own payload and the digest before it. No row in this ledger can
            be altered, removed or reordered without every row after it in its chain failing this
            check.
          </p>
          <ChalkNote tone="gold">try editing one — the button above</ChalkNote>
        </div>
      )}
    </div>
  );
}
