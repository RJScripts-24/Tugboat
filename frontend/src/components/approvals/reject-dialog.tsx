"use client";

import { useEffect, useRef, useState } from "react";

import { ChalkRule } from "@/components/dashboard/chalk";
import { CloseIcon } from "@/components/dashboard/icons";
import { MoneyValue } from "@/components/dashboard/primitives";
import { rejectionReasonsFor, type ApprovalRequest } from "@/lib/approvals-data";

/**
 * A rejection needs a reason (PRD 6.3, page 5).
 *
 * Not friction for its own sake: the reason is the only part of a "no" that
 * survives into the ledger and into the batch report, and a queue of
 * unexplained refusals teaches the planner nothing. The reasons offered are
 * the ones that fit the gate that stopped the action - a hardship stand-down
 * is not refused on margin - and anything else is typed.
 *
 * Deliberately not a `<dialog>` element: `showModal()` cannot be called during
 * render, so the component would have to reach into the DOM on mount to open
 * itself. A scrim with the focus and key handling written out is less
 * machinery and behaves identically.
 */
export function RejectDialog({
  request,
  onCancel,
  onConfirm,
}: {
  request: ApprovalRequest;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const reasons = rejectionReasonsFor(request.gate);
  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const panel = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    first.current?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const reason = note.trim() || selected;

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
        aria-labelledby={`reject-${request.id}`}
        className="modal-panel"
      >
        <div className="surface-head">
          <h2 id={`reject-${request.id}`} className="surface-title">
            Reject {request.id}
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
            {request.headline} — <MoneyValue paise={request.atRiskPaise} /> at risk on{" "}
            <span className="mono">{request.caseId}</span>.
          </p>
          <p className="mt-2 text-[11.5px] leading-[1.55] text-txt-faint">{request.ifRejected}</p>

          <p className="chalk-hand mt-4 text-[13px] uppercase tracking-[0.07em] text-txt-faint">
            Why
          </p>
          <ul className="mt-2 space-y-1">
            {reasons.map((option, i) => (
              <li key={option}>
                <button
                  ref={i === 0 ? first : undefined}
                  type="button"
                  className="reason-option"
                  data-selected={selected === option}
                  onClick={() => setSelected(option)}
                >
                  <span
                    className="mt-[5px] h-[6px] w-[6px] shrink-0 rounded-[1px]"
                    style={{
                      backgroundColor:
                        selected === option ? "var(--color-waiting)" : "rgba(255,253,248,0.25)",
                    }}
                    aria-hidden
                  />
                  {option}
                </button>
              </li>
            ))}
          </ul>

          <textarea
            className="draft-field mt-3"
            rows={2}
            value={note}
            placeholder="Or write your own reason"
            onChange={(event) => setNote(event.target.value)}
            aria-label="Rejection reason"
          />

          <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
            <button type="button" className="btn-op-quiet" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-op-quiet btn-op-danger"
              disabled={!reason}
              onClick={() => reason && onConfirm(reason)}
              style={!reason ? { opacity: 0.45, cursor: "default" } : undefined}
            >
              <CloseIcon className="h-[12px] w-[12px]" />
              Reject request
            </button>
          </div>

          <p className="mt-3 text-[11px] leading-[1.5] text-txt-faint">
            The reason is written to the ledger with your name against it, and appears in the
            batch report&apos;s escalation section.
          </p>
        </div>
      </div>
    </div>
  );
}
