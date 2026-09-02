"use client";

import Link from "next/link";
import { useState, type ComponentType, type ReactNode, type SVGProps } from "react";

import { ChalkRule } from "@/components/dashboard/chalk";
import {
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  ExternalLinkIcon,
  HourglassIcon,
  MailIcon,
  PencilIcon,
  PhoneIcon,
  RetryIcon,
  WhatsAppIcon,
} from "@/components/dashboard/icons";
import { MoneyValue, StatusMark } from "@/components/dashboard/primitives";
import {
  GATE_META,
  type ApprovalRequest,
  type DraftChannel,
} from "@/lib/approvals-data";
import { formatSpan } from "@/lib/clock";
import { TONE_HEX } from "@/lib/dashboard-data";
import { CASE_TYPE_META, ROOT_CAUSE_META } from "@/lib/pipeline-data";
import { RejectDialog } from "./reject-dialog";

/** A decision taken in this session, kept beside the request it answers. */
export type SessionDecision = {
  verdict: "approved" | "rejected";
  reason: string | null;
  /** Wall-clock IST at the moment of the click, formatted once. */
  at: string;
  /** True when the operator rewrote the draft before releasing it. */
  edited: boolean;
  /** True when the yes also put the case back to attempt zero (D-157). */
  restarted?: boolean;
};

const CHANNEL: Record<
  DraftChannel,
  { label: string; Icon: ComponentType<SVGProps<SVGSVGElement>>; quote: string }
> = {
  WHATSAPP: { label: "WhatsApp", Icon: WhatsAppIcon, quote: "quote-whatsapp" },
  EMAIL: { label: "Email", Icon: MailIcon, quote: "quote-email" },
  VOICE: { label: "Voice call", Icon: PhoneIcon, quote: "quote-reply" },
  RETRY: { label: "Razorpay retry", Icon: RetryIcon, quote: "quote" },
};

/**
 * One request for permission (PRD 6.3, page 5).
 *
 * Read left to right it is an argument and then its evidence: what Boa wants
 * to do and why, the caps it was measured against, the exact words that would
 * leave the building - and, in the rail, the case those words are about.
 * Nothing is summarised away, because an approver who cannot see the message
 * is an approver rubber-stamping one.
 *
 * Once decided, the card does not vanish. It shows what executing the decision
 * did to the case, which is the point the PRD makes about approving visibly
 * resuming work - a request that disappears on click leaves the operator
 * wondering whether anything happened at all.
 */
export function RequestCard({
  request,
  decision,
  draftLines,
  onApprove,
  onRestart,
  onReject,
  onEditDraft,
  live = false,
  busy = false,
}: {
  request: ApprovalRequest;
  decision: SessionDecision | null;
  /** The draft as it stands now - edited by the operator, or as planned. */
  draftLines: string[];
  onApprove: (edited: boolean) => void;
  /** Yes, and work it again from the start — handover requests only (D-157). */
  onRestart: (edited: boolean) => void;
  onReject: (reason: string) => void;
  onEditDraft: (lines: string[] | null) => void;
  /** This request arrived while the page was open. */
  live?: boolean;
  /** A decision is in flight — the buttons say so rather than firing twice. */
  busy?: boolean;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [editing, setEditing] = useState(false);

  const gate = GATE_META[request.gate];
  const edited = draftLines.join("\n") !== request.draft.lines.join("\n");
  const waiting = request.requestedMinutesAgo;
  const stale = waiting >= 240;

  return (
    <article className={`surface ${live ? "feed-enter" : ""}`}>
      <div className="surface-head flex-wrap">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3.5 gap-y-1.5">
          <StatusMark tone={gate.tone}>{gate.label}</StatusMark>

          <Link
            href={`/cases/${request.caseId}`}
            className="mono text-[12.5px] text-txt underline-offset-4 hover:underline"
          >
            {request.caseId}
          </Link>

          <span className="truncate text-[13px] text-txt-dim">
            {request.customer}
            <span className="text-txt-faint">
              {" · "}
              {request.segment} · {CASE_TYPE_META[request.caseType].label.toLowerCase()}
            </span>
          </span>

          {live && !decision ? (
            <span className="mono rounded-[2px] border border-waiting/45 px-1.5 py-[1px] text-[10.5px] uppercase tracking-[0.05em] text-waiting">
              just escalated
            </span>
          ) : null}
        </div>

        <span
          className={`meta flex shrink-0 items-center gap-1.5 ${stale && !decision ? "text-waiting" : ""}`}
          title={`Request ${request.id}`}
        >
          <HourglassIcon className="h-[12px] w-[12px]" />
          {decision ? `decided ${decision.at} IST` : waiting === 0 ? "just now" : `waiting ${formatSpan(waiting)}`}
        </span>
      </div>

      <ChalkRule />

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,270px)]">
        <div className="px-5 py-4 sm:px-6 sm:py-5">
          <h3 className="chalk-strong text-[clamp(17px,1.5vw,21px)] font-semibold leading-[1.25] tracking-[-0.015em] text-txt">
            {request.headline}
          </h3>

          <p className="mt-2 text-[12.5px] text-txt-dim">
            <MoneyValue paise={request.atRiskPaise} /> at risk
            {request.concessionPaise > 0 ? (
              <>
                {" · "}
                <MoneyValue paise={request.concessionPaise} /> given away
                {" · "}
                <MoneyValue paise={request.atRiskPaise - request.concessionPaise} /> net if it
                lands
              </>
            ) : (
              " · no concession asked for"
            )}
          </p>

          {/* Boa's argument, quoted rather than paraphrased: this is what the
              planner wrote, and the operator is answering it. */}
          <div className="quote mt-4 space-y-2">
            {request.justification.map((line) => (
              <p key={line} className="text-[12.5px] leading-[1.65] text-txt-dim">
                {line}
              </p>
            ))}
            <p className="mono text-[10.5px] uppercase tracking-[0.06em] text-txt-faint">
              Boa · planner
            </p>
          </div>

          <ul className="mt-4 flex flex-wrap gap-1.5">
            {request.chips.map((chip) => (
              <li
                key={chip.label}
                className="policy-chip"
                style={chip.tone ? { color: TONE_HEX[chip.tone], borderColor: `${TONE_HEX[chip.tone]}55` } : undefined}
              >
                {chip.label}
              </li>
            ))}
          </ul>

          <Draft
            request={request}
            lines={draftLines}
            edited={edited}
            editing={editing}
            frozen={decision !== null}
            onStartEdit={() => setEditing(true)}
            onSave={(next) => {
              onEditDraft(next);
              setEditing(false);
            }}
            onRevert={() => {
              onEditDraft(null);
              setEditing(false);
            }}
          />

          {decision ? (
            <Decided request={request} decision={decision} />
          ) : (
            <>
              <div className="mt-5 flex flex-wrap items-center gap-2.5">
                {/* "Release", not "execute". Approving is a permission: the
                    gate runs again when the release job fires, and it can still
                    defer the message past quiet hours or refuse it outright if
                    the customer opted out while this was waiting (D-67). */}
                <button
                  type="button"
                  onClick={() => onApprove(edited)}
                  className="btn-gold gap-2 px-5 py-[9px] text-[13.5px]"
                  disabled={busy}
                >
                  <CheckIcon className="h-[13px] w-[13px]" />
                  Approve &amp; release
                </button>

                {/* The second kind of yes, and only where it means something:
                    a handover is the one card that asks whether the agent
                    carries on, so it is the one card where "yes, from the
                    top" is an answer (D-157). It is a quiet button rather
                    than a gold one because resetting a customer's contact
                    budget should take a deliberate read, not a reflex. */}
                {request.gate === "escalated_to_human" ? (
                  <button
                    type="button"
                    onClick={() => onRestart(edited)}
                    className="btn-op-quiet"
                    disabled={busy}
                    title={`Attempts back to 0 of ${request.attemptCap}; the channel caps and the cool-down count from now. An opt-out is not cleared.`}
                  >
                    <RetryIcon className="h-[12px] w-[12px]" />
                    Restart the case
                  </button>
                ) : null}

                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="btn-op-quiet"
                  disabled={busy || editing}
                >
                  <PencilIcon className="h-[12px] w-[12px]" />
                  {edited ? "Edit draft again" : "Edit draft first"}
                </button>

                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setRejecting(true)}
                  className="btn-op-quiet btn-op-danger"
                >
                  <CloseIcon className="h-[12px] w-[12px]" />
                  Reject
                </button>
              </div>

              <dl className="mt-4 space-y-1.5 border-t border-white/[0.07] pt-3.5">
                <Consequence label="If you approve" value={request.ifApproved} />
                <Consequence label="If you reject" value={request.ifRejected} />
              </dl>
            </>
          )}
        </div>

        <aside className="border-t border-white/[0.07] px-5 py-4 lg:border-l lg:border-t-0 sm:px-6 lg:py-5">
          <dl className="space-y-2">
            <Fact label="At risk" value={`₹${formatPlain(request.atRiskPaise)}`} mono />
            {request.concessionPaise > 0 ? (
              <Fact label="Concession" value={`₹${formatPlain(request.concessionPaise)}`} mono />
            ) : null}
            <Fact label="Root cause" value={ROOT_CAUSE_META[request.rootCause].label} />
            <Fact
              label="Confidence"
              value={request.confidence === null ? "—" : request.confidence.toFixed(2)}
              mono
              tone={
                request.confidence !== null && request.confidence < 0.6 ? "diagnosis" : undefined
              }
            />
            <Fact label="Contact" value={request.contact} mono />
            <Fact label="Request" value={request.id} mono />
          </dl>

          <div className="mt-3.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="chalk-hand text-[13px] uppercase tracking-[0.07em] text-txt-faint">
                Attempts
              </span>
              <span className="mono text-[12px] text-txt">
                {request.attempts} of {request.attemptCap}
              </span>
            </div>
            <div className="mt-2 flex gap-1.5" aria-hidden>
              {Array.from({ length: request.attemptCap }, (_, i) => (
                <span key={i} className="pip" data-used={i < request.attempts} />
              ))}
            </div>
          </div>

          {request.candidates.length > 0 ? (
            <div className="mt-4 border-t border-white/[0.07] pt-3.5">
              <p className="chalk-hand text-[13px] uppercase tracking-[0.07em] text-txt-faint">
                What Boa thinks it is
              </p>
              <ul className="mt-2 space-y-1.5">
                {request.candidates.map((candidate) => (
                  <li key={candidate.label}>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="min-w-0 truncate text-[12px] text-txt-dim">
                        {candidate.label}
                      </span>
                      <span className="mono shrink-0 text-[11.5px] text-txt-faint">
                        {candidate.probability.toFixed(2)}
                      </span>
                    </div>
                    <span
                      className="mt-1 block h-[3px] rounded-[1px] bg-white/[0.08]"
                      aria-hidden
                    >
                      <span
                        className="block h-full rounded-[1px] bg-diagnosis/70"
                        style={{ width: `${Math.round(candidate.probability * 100)}%` }}
                      />
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-2.5 text-[11px] leading-[1.5] text-txt-faint">
                None of these was written to the case. A diagnosis under the floor is not
                recorded as one.
              </p>
            </div>
          ) : null}

          <p className="mt-4 border-t border-white/[0.07] pt-3.5 text-[11px] leading-[1.55] text-txt-faint">
            {gate.rule}.{" "}
            <Link href="/policies" className="text-txt-dim underline-offset-2 hover:underline">
              Configured in Policies
            </Link>
            .
          </p>
        </aside>
      </div>

      {rejecting ? (
        <RejectDialog
          request={request}
          onCancel={() => setRejecting(false)}
          onConfirm={(reason) => {
            setRejecting(false);
            onReject(reason);
          }}
        />
      ) : null}
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* The draft                                                           */
/* ------------------------------------------------------------------ */

/**
 * The message, exactly as it would be sent - and editable before it is.
 *
 * Closed by default so seven cards stay scannable; opened, it is the whole
 * body plus the payment link and the channel it would go out on. Editing
 * replaces the planner's words with the operator's and says so on the card,
 * because an approval that quietly changed the message is an audit problem.
 */
function Draft({
  request,
  lines,
  edited,
  editing,
  frozen,
  onStartEdit,
  onSave,
  onRevert,
}: {
  request: ApprovalRequest;
  lines: string[];
  edited: boolean;
  editing: boolean;
  frozen: boolean;
  onStartEdit: () => void;
  onSave: (lines: string[]) => void;
  onRevert: () => void;
}) {
  const channel = CHANNEL[request.draft.channel];
  const Icon = channel.Icon;

  if (editing && !frozen) {
    // Keyed on the text it is editing: restoring Boa's wording and then opening
    // the editor again has to show Boa's wording, not the discarded rewrite.
    return (
      <Editor
        key={lines.join("\n")}
        heading={`Editing the draft · ${channel.label} to ${request.draft.to}`}
        lines={lines}
        onSave={onSave}
        onRevert={onRevert}
      />
    );
  }

  return (
    <details className="group mt-4" open={edited}>
      <summary className="disclose cursor-pointer list-none">
        <ChevronDownIcon className="h-[11px] w-[11px] transition-transform group-open:rotate-180" />
        <Icon className="h-[12px] w-[12px]" />
        {request.draft.channel === "RETRY"
          ? `The call that would be made · ${request.draft.to}`
          : `The message that would be sent · ${channel.label} to ${request.draft.to}`}
        {edited ? (
          <span className="mono ml-1.5 rounded-[2px] border border-waiting/45 px-1.5 text-[10px] uppercase tracking-[0.05em] text-waiting">
            edited
          </span>
        ) : null}
      </summary>

      <div className={`quote ${channel.quote} mt-3`}>
        {request.draft.subject ? (
          <p className="text-[12.5px] font-medium text-txt">{request.draft.subject}</p>
        ) : null}
        <div className={request.draft.subject ? "mt-1.5 space-y-1.5" : "space-y-1.5"}>
          {lines.map((line, i) => (
            <p
              key={`${i}-${line}`}
              className={`text-[12.5px] leading-[1.65] text-txt-dim ${
                request.draft.channel === "RETRY" ? "mono text-[11.5px]" : ""
              }`}
            >
              {line}
            </p>
          ))}
        </div>

        {request.draft.link ? (
          <span className="mono mt-2.5 inline-flex items-center gap-1.5 rounded-[2px] border border-white/15 px-2 py-[3px] text-[11px] text-txt-faint">
            <ExternalLinkIcon className="h-[11px] w-[11px]" />
            {request.draft.link}
          </span>
        ) : null}
      </div>

      <p className="mt-2.5 text-[11px] leading-[1.5] text-txt-faint">{request.draft.note}.</p>

      {!frozen ? (
        <button type="button" className="btn-op-quiet mt-2.5" onClick={onStartEdit}>
          <PencilIcon className="h-[12px] w-[12px]" />
          Edit this draft
        </button>
      ) : null}
    </details>
  );
}

/** The textarea half of the draft, holding one operator's rewrite. */
function Editor({
  heading,
  lines,
  onSave,
  onRevert,
}: {
  heading: string;
  lines: string[];
  onSave: (lines: string[]) => void;
  onRevert: () => void;
}) {
  const [text, setText] = useState(lines.join("\n"));

  return (
    <div className="mt-4">
      <p className="chalk-hand text-[13px] uppercase tracking-[0.07em] text-txt-faint">{heading}</p>
      <textarea
        className="draft-field mt-2"
        rows={Math.max(5, lines.length + 2)}
        value={text}
        onChange={(event) => setText(event.target.value)}
        aria-label="Draft message"
      />
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn-op-quiet"
          onClick={() => onSave(text.split("\n").filter((line) => line.trim().length > 0))}
        >
          <CheckIcon className="h-[12px] w-[12px]" />
          Save draft
        </button>
        <button type="button" className="btn-op-quiet" onClick={onRevert}>
          Restore Boa&apos;s wording
        </button>
        <span className="text-[11px] text-txt-faint">
          Your version is what gets sent, and the ledger records that you wrote it.
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* After the decision                                                  */
/* ------------------------------------------------------------------ */

/**
 * What the click did.
 *
 * An approval is not a state change on a row - it releases a blocked action,
 * and this is that action landing: the gate re-run, the thing executed, the
 * case picked back up inside the same bounds it had before. A rejection shows
 * the reason and what the agent does instead, which is usually nothing.
 */
function Decided({
  request,
  decision,
}: {
  request: ApprovalRequest;
  decision: SessionDecision;
}) {
  const approved = decision.verdict === "approved";

  return (
    <div className="mt-5 border-t border-white/[0.07] pt-4">
      <p className="chalk-hand flex items-center gap-2 text-[15px] uppercase tracking-[0.06em] text-txt">
        {approved ? (
          <CheckIcon className="h-[13px] w-[13px] text-txt" />
        ) : (
          <CloseIcon className="h-[13px] w-[13px] text-halted" />
        )}
        {approved ? (decision.restarted ? "Restarted" : "Approved") : "Rejected"} · {decision.at}{" "}
        IST
      </p>

      {approved ? (
        <ol className="mt-3 space-y-2.5">
          {decision.restarted ? (
            <li className="flex gap-3">
              <span className="mono mt-[2px] shrink-0 text-[10.5px] text-txt-faint">00</span>
              <span className="min-w-0">
                <span className="text-[12.5px] text-txt-dim">Counters reset</span>
                <span className="block text-[11.5px] leading-[1.5] text-txt-faint">
                  Attempts back to 0 of {request.attemptCap}; the channel caps, the cool-down and
                  the re-presentation count are measured from now. The opt-out and hardship blocks
                  are untouched, and every message already sent stays on the timeline.
                </span>
              </span>
            </li>
          ) : null}
          {request.resumeSteps.map((step, i) => (
            <li key={step.label} className="flex gap-3">
              <span className="mono mt-[2px] shrink-0 text-[10.5px] text-txt-faint">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span className="min-w-0">
                <span className="text-[12.5px] text-txt-dim">{step.label}</span>
                <span className="block text-[11.5px] leading-[1.5] text-txt-faint">
                  {step.detail}
                </span>
              </span>
            </li>
          ))}
          {decision.edited ? (
            <li className="flex gap-3">
              <span className="mono mt-[2px] shrink-0 text-[10.5px] text-txt-faint">
                {String(request.resumeSteps.length + 1).padStart(2, "0")}
              </span>
              <span className="min-w-0">
                <span className="text-[12.5px] text-txt-dim">Draft attributed to you</span>
                <span className="block text-[11.5px] leading-[1.5] text-txt-faint">
                  The ledger records the message as edited by the operator, not written by Boa
                </span>
              </span>
            </li>
          ) : null}
        </ol>
      ) : (
        <div className="mt-3">
          <p className="text-[12.5px] leading-[1.6] text-txt-dim">
            <span className="text-txt-faint">Reason given: </span>
            {decision.reason}
          </p>
          <p className="mt-2 text-[12px] leading-[1.6] text-txt-faint">{request.ifRejected}</p>
        </div>
      )}

      <p className="mt-3.5 text-[11.5px] leading-[1.55] text-txt-faint">
        Written to the ledger as{" "}
        <span className="mono">HUMAN · APPROVAL_DECIDED</span> against {request.caseId}.{" "}
        <Link
          href={`/cases/${request.caseId}`}
          className="text-txt-dim underline-offset-2 hover:underline"
        >
          Open the case →
        </Link>
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Consequence({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap gap-x-2 text-[11.5px] leading-[1.55]">
      <dt className="shrink-0 text-txt-faint">{label}:</dt>
      <dd className="min-w-0 flex-1 text-txt-dim">{value}</dd>
    </div>
  );
}

function Fact({
  label,
  value,
  mono,
  tone,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  tone?: "diagnosis";
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-[11.5px] text-txt-faint">{label}</dt>
      <dd
        className={`min-w-0 truncate text-right text-[12px] ${mono ? "mono" : ""} ${
          tone === "diagnosis" ? "text-diagnosis" : "text-txt-dim"
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

/** Rupees without the symbol - the label beside it already carries the sense. */
function formatPlain(paise: number): string {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(
    Math.round(paise / 100),
  );
}
