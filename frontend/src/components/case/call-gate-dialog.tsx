"use client";

import { useEffect, useRef } from "react";

import { ChalkRule } from "@/components/dashboard/chalk";
import { CloseIcon, PhoneIcon } from "@/components/dashboard/icons";
import type { CallPreview } from "@/lib/actions";

/**
 * What is holding the call, before a human decides to ring anyway (D-160).
 *
 * "Ask Boa to call now" used to post straight through and let the gate answer
 * in a worker, which meant a refused call looked exactly like a working one:
 * the click landed, a ledger row appeared, and nothing rang. This asks the gate
 * first and shows its answer.
 *
 * The rules listed here are the gate's own `checks`, from a dry run of the same
 * `evaluateGate` that will decide. Nothing on this dialog is a second copy of
 * the policy — the B-79 mistake was a table that described a pack nobody was
 * running, and a dialog that hand-lists rules would be that mistake with a
 * button on it.
 *
 * Only a cool-down offers a way through. Everything else — quiet hours, an
 * opt-out, the caps — renders as a refusal with no proceed button, because a
 * merchant may spend their own pacing and may not spend a customer's consent.
 */
export function CallGateDialog({
  caseId,
  preview,
  busy,
  onProceed,
  onCancel,
}: {
  caseId: string;
  preview: CallPreview;
  busy: boolean;
  onProceed: () => void;
  onCancel: () => void;
}) {
  const panel = useRef<HTMLDivElement | null>(null);
  const first = useRef<HTMLButtonElement | null>(null);

  useEffect(() => first.current?.focus(), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const waivable = preview.blocks.filter((block) => block.waivable);

  return (
    <div
      className="modal-scrim"
      onMouseDown={(event) => {
        if (!panel.current?.contains(event.target as Node)) onCancel();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`call-gate-${caseId}`}
        className="modal-panel"
      >
        <div className="surface-head">
          <h2 id={`call-gate-${caseId}`} className="surface-title">
            {preview.refused ? "The call is refused" : "The policy is holding this call"}
          </h2>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel"
            className="rounded-[3px] p-1 text-txt-faint transition-colors hover:text-txt"
          >
            <CloseIcon className="h-[13px] w-[13px]" />
          </button>
        </div>

        <ChalkRule />

        <div className="px-5 py-4">
          <p className="text-[12.5px] leading-[1.6] text-txt-dim">
            The gate was asked what would happen if Boa rang{" "}
            <span className="mono">{caseId}</span> right now. It objected on{" "}
            {preview.blocks.length === 1 ? "this ground" : "these grounds"}.
          </p>

          <ul className="mt-3 space-y-2">
            {preview.blocks.map((block) => (
              <li
                key={block.name}
                className="rounded-[2px] border px-3 py-2"
                style={{
                  borderColor: block.waivable
                    ? "rgba(255,232,134,0.28)"
                    : "rgba(229,72,77,0.32)",
                }}
              >
                <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span
                    className="chalk-hand text-[13px] uppercase tracking-[0.07em]"
                    style={{
                      color: block.waivable ? "var(--color-waiting)" : "var(--color-halted)",
                    }}
                  >
                    {block.name}
                  </span>
                  <span className="mono text-[10.5px] uppercase tracking-[0.08em] text-txt-faint">
                    {block.waivable ? "you may override this" : "not yours to override"}
                  </span>
                </p>
                <p className="mt-1 text-[11.5px] leading-[1.55] text-txt-faint">{block.note}</p>
              </li>
            ))}
          </ul>

          <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
            <button
              ref={preview.refused ? first : undefined}
              type="button"
              className="btn-op-quiet"
              onClick={onCancel}
            >
              {preview.refused ? "Close" : "Cancel"}
            </button>

            {preview.refused ? null : (
              <button
                ref={first}
                type="button"
                className="btn-op-quiet"
                disabled={busy}
                onClick={onProceed}
                style={busy ? { opacity: 0.45, cursor: "default" } : undefined}
              >
                <PhoneIcon className="h-[12px] w-[12px]" />
                Call anyway
              </button>
            )}
          </div>

          <p className="mt-3 text-[11px] leading-[1.5] text-txt-faint">
            {preview.refused ? (
              <>
                Nothing here is a pacing rule. Quiet hours implement TRAI&apos;s DND window and an
                opt-out is the customer&apos;s own, so neither is spent by a button on this page.
              </>
            ) : (
              <>
                {waivable.length === 1 ? "The rule" : "The rules"} above will be recorded as waived
                by you, on this case&apos;s chain, with your name against{" "}
                {waivable.length === 1 ? "it" : "them"}. Every other bound still applies — if quiet
                hours or an opt-out were also holding the call, this button would not be here.
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
