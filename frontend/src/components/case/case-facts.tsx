import Link from "next/link";
import type { ComponentType, ReactNode, SVGProps } from "react";

import { ChalkRule } from "@/components/dashboard/chalk";
import {
  CardIcon,
  CartIcon,
  ExternalLinkIcon,
  InvoiceIcon,
  LockIcon,
  MandateIcon,
} from "@/components/dashboard/icons";
import { MoneyValue, Section, StatusMark } from "@/components/dashboard/primitives";
import { formatSpan, stampOf } from "@/lib/clock";
import {
  CASE_TYPE_META,
  CHANNEL_META,
  ROOT_CAUSE_META,
  stageBadgeOf,
  type CaseDetail,
  type CaseType,
} from "@/lib/case-detail-data";

const TYPE_ICON: Record<CaseType, ComponentType<SVGProps<SVGSVGElement>>> = {
  PAYMENT_FAILED: CardIcon,
  CHECKOUT_ABANDONED: CartIcon,
  MANDATE_FAILED: MandateIcon,
  INVOICE_OVERDUE: InvoiceIcon,
};

/**
 * The left column: what this case is, whose money it is, and what the agent is
 * still allowed to do about it (PRD 6.3, page 4).
 *
 * Sticky on desktop, because the timeline beside it can run for several
 * screens and the amount at risk is the fact every node has to be read
 * against. The Bounds panel underneath is the whole "bounded workflow" claim
 * rendered as live numbers rather than asserted in a caption - attempts left,
 * channels left, the window contact is allowed in, and what would stop it.
 */
export function CaseFacts({
  detail,
  attemptsUsed,
  extraChannel,
}: {
  detail: CaseDetail;
  /** Ticks up as scheduled work lands, so the panel never lags the timeline. */
  attemptsUsed: number;
  /** The channel a live-arriving action spent, if one has arrived. */
  extraChannel: string | null;
}) {
  const { record, customer, origin } = detail;
  const stage = stageBadgeOf(record);
  const cause = ROOT_CAUSE_META[record.rootCause];
  const Icon = TYPE_ICON[record.type];
  const opened = stampOf(detail.openedMinutesAgo);
  const moved = stampOf(record.updatedMinutesAgo);

  return (
    // Sticky only once there is a column beside it to be sticky *against*: the
    // grid goes three-column at `xl`, so pinning at `lg` left a stacked layout
    // with this card nailed to the top and the timeline scrolling through it.
    <div className="space-y-3 xl:sticky xl:top-[92px]">
      <section className="surface p-5">
        <p className="chalk-hand text-[13px] uppercase tracking-[0.08em] text-txt-faint">
          {record.stage === "recovered" ? "Recovered" : "At risk"}
        </p>
        <p className="chalk-strong mt-2 text-[clamp(30px,3vw,40px)] font-semibold leading-none tracking-[-0.02em] text-txt">
          <MoneyValue
            paise={record.amountPaise}
            className={record.stage === "recovered" ? "text-recovered" : undefined}
          />
        </p>

        <ChalkRule className="mt-3.5" />

        <div className="mt-3.5 flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="flex items-center gap-2 text-[13px] text-txt-dim">
            <Icon className="h-[15px] w-[15px] shrink-0 opacity-70" />
            {CASE_TYPE_META[record.type].label}
          </span>
          <StatusMark tone={stage.tone} pulsing={stage.pulsing}>
            {stage.label}
          </StatusMark>
        </div>

        <p className="mt-3 text-[12.5px] leading-[1.55] text-txt-dim">
          {record.confidence === null ? (
            <span className="italic text-txt-faint">Queued for diagnosis</span>
          ) : (
            <>
              {cause.label}
              <span className="mono ml-2 text-[11.5px] text-txt-faint">
                {record.confidence.toFixed(2)} · {record.method === "LLM" ? "LLM" : "rules"}
              </span>
            </>
          )}
        </p>
      </section>

      <Section title="Customer" bodyClassName="px-5 py-4">
        <p className="text-[15px] font-medium leading-none text-txt">{customer.name}</p>
        <p className="mt-1.5 text-[11.5px] text-txt-faint">
          {customer.segment} · {customer.history}
        </p>

        <dl className="mt-3.5 space-y-2">
          <Fact label="Phone" value={customer.phone} mono />
          <Fact label="Email" value={customer.email} mono />
          <Fact label="Language" value={customer.language} mono />
          <Fact label="Timezone" value={customer.timezone} mono />
        </dl>

        <p className="mt-3 border-t border-white/[0.07] pt-3 text-[11.5px] leading-[1.5] text-txt-faint">
          {customer.languageNote}. Contacts are masked here and in every prompt the model sees.
        </p>
      </Section>

      <Section title="Origin" bodyClassName="px-5 py-4">
        <p className="text-[11.5px] uppercase tracking-[0.06em] text-txt-faint">{origin.kind}</p>
        <a
          href={origin.href}
          target="_blank"
          rel="noreferrer noopener"
          className="filter-control mono mt-2 max-w-full text-[12px]"
          title="Open in the Razorpay test-mode dashboard"
        >
          <span className="truncate">{origin.id}</span>
          <ExternalLinkIcon className="h-[12px] w-[12px] shrink-0 opacity-70" />
        </a>

        <dl className="mt-3.5 space-y-2">
          <Fact label="Reference" value={origin.reference} mono />
          <Fact label="Opened" value={`${opened.day} · ${opened.time} IST`} mono />
          <Fact label="Last moved" value={`${moved.day} · ${moved.time} IST`} mono />
          <Fact label="Open for" value={formatSpan(detail.openedMinutesAgo)} mono />
        </dl>
      </Section>

      <BoundsPanel detail={detail} attemptsUsed={attemptsUsed} extraChannel={extraChannel} />
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Bounds (PRD 6.3, page 4 - "do not omit it").
 *
 * Every number here is a limit the PolicyGate will actually enforce on the
 * next action, not a description of one. Read top to bottom it answers: how
 * much rope is left, on which channels, inside which hours, and what would
 * end the case early.
 */
function BoundsPanel({
  detail,
  attemptsUsed,
  extraChannel,
}: {
  detail: CaseDetail;
  attemptsUsed: number;
  extraChannel: string | null;
}) {
  const { bounds } = detail;
  const spent = attemptsUsed >= bounds.attemptCap;

  return (
    <Section
      title="Bounds"
      meta={`policy ${bounds.policyVersion}`}
      bodyClassName="px-5 py-4 space-y-4"
    >
      <div>
        <div className="flex items-baseline justify-between gap-3">
          <span className="chalk-hand text-[13px] uppercase tracking-[0.07em] text-txt-faint">
            Attempts
          </span>
          <span className={`mono text-[13px] ${spent ? "text-halted" : "text-txt"}`}>
            {attemptsUsed} of {bounds.attemptCap}
          </span>
        </div>
        <div className="mt-2 flex gap-1.5" aria-hidden>
          {Array.from({ length: bounds.attemptCap }, (_, i) => (
            <span
              key={i}
              className="pip"
              data-used={i < attemptsUsed}
              data-spent={spent}
            />
          ))}
        </div>
        <p className="mt-2 text-[11.5px] leading-[1.5] text-txt-faint">
          {bounds.closed
            ? bounds.closedNote
            : spent
              ? "The cap is reached. No further action is possible on this case — the gate refuses it."
              : `${bounds.attemptCap - attemptsUsed} attempt${
                  bounds.attemptCap - attemptsUsed === 1 ? "" : "s"
                } left before the case closes as exhausted.`}
        </p>
      </div>

      <div>
        <p className="chalk-hand text-[13px] uppercase tracking-[0.07em] text-txt-faint">
          Channels
        </p>
        <ul className="mt-2 space-y-1.5">
          {bounds.channels.map(({ channel, used, cap }) => {
            const live = extraChannel === channel ? 1 : 0;
            const total = Math.min(cap, used + live);
            return (
              <li key={channel} className="flex items-center justify-between gap-3 text-[12.5px]">
                <span className="text-txt-dim">{CHANNEL_META[channel].label}</span>
                <span
                  className={`mono text-[12px] ${total >= cap ? "text-halted" : "text-txt-faint"}`}
                >
                  {total}/{cap}
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      <ChalkRule />

      <dl className="space-y-3">
        <Bound label="Quiet hours" value={bounds.quietHours} note={bounds.quietNote} />
        <Bound
          label="Cool-down"
          value={
            bounds.closed
              ? "—"
              : bounds.coolDownMinutesLeft === null
                ? "Clear"
                : formatSpan(bounds.coolDownMinutesLeft)
          }
          note={bounds.coolDownNote}
          tone={bounds.coolDownMinutesLeft === null ? undefined : "waiting"}
        />
        <Bound
          label="Opt-out"
          value={bounds.optedOut ? "On record" : "None"}
          note={bounds.optOutNote}
          tone={bounds.optedOut ? "halted" : undefined}
          locked
        />
        <Bound label="Deadline" value="Set" note={bounds.deadlineNote} />
      </dl>

      <Link
        href="/policies"
        className="disclose"
        title="Every bound on this panel is a configurable policy object"
      >
        These bounds come from policy {bounds.policyVersion} →
      </Link>
    </Section>
  );
}

/* ------------------------------------------------------------------ */

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-[11.5px] text-txt-faint">{label}</dt>
      <dd
        className={`min-w-0 truncate text-right text-[12px] text-txt-dim ${mono ? "mono" : ""}`}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}

function Bound({
  label,
  value,
  note,
  tone,
  locked = false,
}: {
  label: string;
  value: string;
  note: ReactNode;
  tone?: "waiting" | "halted";
  locked?: boolean;
}) {
  const colour = tone === "halted" ? "text-halted" : tone === "waiting" ? "text-waiting" : "text-txt";

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <dt className="flex items-center gap-1.5 text-[12.5px] text-txt-dim">
          {label}
          {/* The opt-out rule is the one the Policies page renders locked. */}
          {locked ? <LockIcon className="h-[11px] w-[11px] opacity-45" /> : null}
        </dt>
        <dd className={`mono shrink-0 text-[12px] ${colour}`}>{value}</dd>
      </div>
      <p className="mt-1 text-[11.5px] leading-[1.5] text-txt-faint">{note}</p>
    </div>
  );
}
