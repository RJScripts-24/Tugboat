"use client";

import { useEffect, useRef, useState, type ComponentType, type ReactNode, type SVGProps } from "react";

import { ChalkRule } from "@/components/dashboard/chalk";
import {
  ChevronDownIcon,
  EscalateIcon,
  GavelIcon,
  HaltIcon,
  MagnifierSmallIcon,
  MailIcon,
  PhoneIcon,
  PlanIcon,
  PlayIcon,
  PauseIcon,
  PromiseIcon,
  RecoveredIcon,
  ReplyIcon,
  RetryIcon,
  ShieldBlockIcon,
  ShieldCheckSmallIcon,
  StethoscopeIcon,
  WhatsAppIcon,
} from "@/components/dashboard/icons";
import { MoneyValue } from "@/components/dashboard/primitives";
import { TONE_HEX, type Tone } from "@/lib/dashboard-data";
import {
  CHANNEL_META,
  stampOf,
  type CaseEvent,
  type EventBody,
  type EventKind,
  type FactRow,
  type PolicyCheck,
  type Turn,
} from "@/lib/case-detail-data";

/* ------------------------------------------------------------------ */
/* Node vocabulary                                                     */
/* ------------------------------------------------------------------ */

/**
 * One mark and one colour per node type (PRD 6.3, page 4).
 *
 * The colours obey the product's law rather than the node's importance: green
 * is recovered money and nothing else, red is halted or blocked, amber is
 * waiting on someone, blue is diagnosis. Everything the agent simply *did* is
 * chalk-white, which is why a page full of actions still reads calm and the
 * two nodes that changed the money jump out of it.
 */
const NODE: Record<EventKind, { Icon: ComponentType<SVGProps<SVGSVGElement>>; tone: Tone }> = {
  DETECTED: { Icon: MagnifierSmallIcon, tone: "neutral" },
  DIAGNOSED: { Icon: StethoscopeIcon, tone: "diagnosis" },
  PLANNED: { Icon: PlanIcon, tone: "neutral" },
  POLICY_CHECK: { Icon: ShieldCheckSmallIcon, tone: "neutral" },
  EMAIL_SENT: { Icon: MailIcon, tone: "neutral" },
  WHATSAPP_SENT: { Icon: WhatsAppIcon, tone: "neutral" },
  VOICE_CALL: { Icon: PhoneIcon, tone: "waiting" },
  RETRY_EXECUTED: { Icon: RetryIcon, tone: "neutral" },
  CUSTOMER_REPLY: { Icon: ReplyIcon, tone: "neutral" },
  PROMISE_RECORDED: { Icon: PromiseIcon, tone: "waiting" },
  ESCALATED: { Icon: EscalateIcon, tone: "waiting" },
  // A human decided. White chalk, never green: the ledger already treats an
  // operator as the brightest mark on the board, and green means money back.
  APPROVAL_DECIDED: { Icon: GavelIcon, tone: "neutral" },
  HALTED: { Icon: HaltIcon, tone: "halted" },
  RECOVERED: { Icon: RecoveredIcon, tone: "recovered" },
};

const TERMINAL: EventKind[] = [
  "RECOVERED",
  "HALTED",
  "ESCALATED",
  "PROMISE_RECORDED",
  "APPROVAL_DECIDED",
];

/* ------------------------------------------------------------------ */
/* Timeline                                                            */
/* ------------------------------------------------------------------ */

/**
 * The recovery timeline - the heart of the product (PRD 6.3, page 4).
 *
 * One node per event in the case's append-only log, strictly chronological,
 * oldest at the top. Nothing here is a summary of what happened: it *is* what
 * happened, rendered from the same rows the audit ledger hashes, which is what
 * makes "replay this case" a real claim rather than a slide.
 *
 * Every node opens. Closed, the timeline is a story you can read in fifteen
 * seconds; opened, a single node carries the error code, the rejected
 * alternatives, the six policy checks or the exact text that left the
 * building. A panelist who wants the evidence can always get to it, and one
 * who wants the shape never has to wade through it.
 */
export function CaseTimeline({
  events,
  pending,
  revealed,
}: {
  events: CaseEvent[];
  pending: CaseEvent[];
  /** How many pending nodes have arrived. */
  revealed: number;
}) {
  const arrived = pending.slice(0, revealed);
  const waiting = pending.length - revealed;

  return (
    // `self-start` so a short case does not draw a tall empty box: the column
    // ends where the story does, and the sticky facts beside it still travel.
    <section className="surface flex flex-col self-start">
      <div className="surface-head">
        <h2 className="surface-title">Recovery timeline</h2>
        <span className="meta">
          {events.length + arrived.length} events
          {waiting > 0 ? " · live" : ""}
        </span>
      </div>
      <ChalkRule />

      <ol className="relative px-4 py-5 sm:px-6">
        {/* The rail runs the height of the list, behind every marker. */}
        <span className="rail left-[27px] sm:left-[39px]" aria-hidden />

        {events.map((event, i) => (
          <Node key={event.id} event={event} last={i === events.length - 1 && arrived.length === 0} />
        ))}

        {arrived.map((event, i) => (
          <Node key={event.id} event={event} last={i === arrived.length - 1} live />
        ))}

        {waiting > 0 ? <Waiting /> : null}
      </ol>
    </section>
  );
}

/** The agent is still working, and the next node has not landed yet. */
function Waiting() {
  return (
    <li className="relative flex gap-4 pl-[1px]">
      <span
        className="node-mark border-dashed text-txt-faint"
        style={{ opacity: 0.5 }}
        aria-hidden
      >
        <span className="pulse-dot h-[6px] w-[6px] rounded-full bg-waiting" />
      </span>
      <p className="pt-[7px] text-[12.5px] italic text-txt-faint">
        Boa is working this case — the next node arrives here.
      </p>
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* One node                                                            */
/* ------------------------------------------------------------------ */

function Node({
  event,
  last,
  live = false,
}: {
  event: CaseEvent;
  last: boolean;
  /** This node arrived while the page was open. */
  live?: boolean;
}) {
  const blocked = event.badge?.label === "BLOCKED";
  const spec = NODE[event.kind];
  const Icon = event.kind === "POLICY_CHECK" && blocked ? ShieldBlockIcon : spec.Icon;
  const tone: Tone = blocked ? "halted" : spec.tone;
  const hex = TONE_HEX[tone];
  const emphasis = TERMINAL.includes(event.kind);
  const stamp = stampOf(event.minutesAgo);

  return (
    <li className={`relative flex gap-4 ${last ? "" : "pb-5"} ${live ? "node-enter" : ""}`}>
      <span className="node-mark" data-emphasis={emphasis} style={{ color: hex }}>
        <Icon className="h-[14px] w-[14px]" />
      </span>

      <div className="min-w-0 flex-1 pt-[3px]">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="mono shrink-0 text-[11.5px] text-txt-faint">
            {stamp.day} · {stamp.time}
          </span>
          <h3
            className="chalk-hand text-[15px] uppercase leading-none tracking-[0.04em]"
            style={{ color: emphasis || blocked ? hex : "var(--color-txt)" }}
          >
            {event.title}
          </h3>
          {event.badge ? <Badge label={event.badge.label} tone={event.badge.tone} /> : null}
          {live ? <Badge label="just now" tone="waiting" /> : null}
        </div>

        <p className="mt-1.5 text-[13px] leading-[1.55] text-txt-dim">{event.summary}</p>

        {event.body ? <Body body={event.body} kind={event.kind} /> : null}
      </div>
    </li>
  );
}

function Badge({ label, tone }: { label: string; tone: Tone }) {
  const hex = TONE_HEX[tone];
  return (
    <span
      className="mono shrink-0 rounded-[2px] border px-1.5 py-[1px] text-[10.5px] uppercase tracking-[0.05em]"
      style={{ color: hex, borderColor: `${hex}55` }}
    >
      {label}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Bodies                                                              */
/* ------------------------------------------------------------------ */

/**
 * The expandable half of a node.
 *
 * `<details>` rather than React state: it is keyboard-operable and printable
 * for free, and a timeline of thirty nodes should not carry thirty pieces of
 * component state to remember which ones a reader opened.
 */
function Disclosure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="group mt-2.5">
      <summary className="disclose cursor-pointer list-none">
        <ChevronDownIcon className="h-[11px] w-[11px] transition-transform group-open:rotate-180" />
        {label}
      </summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}

function Body({ body, kind }: { body: EventBody; kind: EventKind }) {
  switch (body.type) {
    case "facts":
      return (
        <Disclosure label={kind === "RECOVERED" ? "How it was recovered" : "Details"}>
          <Facts rows={body.rows} />
        </Disclosure>
      );

    case "diagnosis":
      return (
        <>
          {/* The reasoning is the node, not an appendix to it: a diagnosis
              nobody can read is indistinguishable from a guess. */}
          <div className="mt-2.5 space-y-1.5">
            {body.reasoning.map((line) => (
              <p key={line} className="text-[12.5px] leading-[1.6] text-txt-faint">
                {line}
              </p>
            ))}
          </div>
          <Disclosure label="Diagnosis record">
            <Facts rows={body.rows} />
          </Disclosure>
        </>
      );

    case "plan":
      return (
        <Disclosure label="Why this, and what was rejected">
          <p className="text-[12.5px] leading-[1.6] text-txt-dim">{body.because}</p>
          <p className="mt-3.5 text-[11px] uppercase tracking-[0.07em] text-txt-faint">
            Rejected
          </p>
          <ul className="mt-2 space-y-2">
            {body.rejected.map((item) => (
              <li key={item.option} className="text-[12.5px] leading-[1.5]">
                <span className="text-txt-dim line-through decoration-white/25">{item.option}</span>
                <span className="ml-2 text-txt-faint">— {item.reason}</span>
              </li>
            ))}
          </ul>
        </Disclosure>
      );

    case "policy":
      return (
        // No count in the label: the title already says "5/5 passed", and a
        // list that also contains the exempted check would contradict it.
        <Disclosure label="The checks">
          <ul className="space-y-2">
            {body.checks.map((check) => (
              <CheckRow key={check.name} check={check} />
            ))}
          </ul>
          <div className="mt-3.5">
            <Facts rows={body.rows} />
          </div>
        </Disclosure>
      );

    case "message":
      return (
        <>
          <div className={`quote quote-${body.channel.toLowerCase()} mt-3`}>
            {body.subject ? (
              <p className="text-[12.5px] font-medium text-txt">{body.subject}</p>
            ) : null}
            <div className={body.subject ? "mt-1.5 space-y-1" : "space-y-1"}>
              {body.lines.map((line) => (
                <p key={line} className="text-[12.5px] leading-[1.6] text-txt-dim">
                  {line}
                </p>
              ))}
            </div>
            {body.link ? (
              <span className="mono mt-2.5 inline-flex items-center gap-1.5 rounded-[2px] border border-white/15 px-2 py-[3px] text-[11px] text-txt-faint">
                {body.link}
              </span>
            ) : null}
          </div>
          <Disclosure label="Delivery record">
            <Facts rows={body.rows} />
          </Disclosure>
        </>
      );

    case "voice":
      return (
        <>
          <VoicePlayer seconds={body.seconds} turns={body.transcript} />
          <p className="mt-3 text-[12.5px] leading-[1.6] text-txt-faint">{body.summary}</p>
          <Disclosure label="Transcript and call record">
            <ol className="space-y-2.5">
              {body.transcript.map((turn, i) => (
                <TurnRow key={i} turn={turn} />
              ))}
            </ol>
            <div className="mt-3.5">
              <Facts rows={body.rows} />
            </div>
          </Disclosure>
        </>
      );

    case "reply":
      return (
        <>
          <div className="quote quote-reply mt-3">
            <p className="text-[12.5px] leading-[1.6] text-txt">{body.text}</p>
            <p className="mono mt-1.5 text-[11px] text-txt-faint">
              inbound · {CHANNEL_META[body.channel].label}
            </p>
          </div>
          <Disclosure label="Classification and consequence">
            <Facts rows={body.rows} />
          </Disclosure>
        </>
      );

    case "promise":
      return (
        <>
          <div className="mt-3 flex flex-wrap items-baseline gap-x-5 gap-y-2 border border-white/[0.14] px-4 py-3">
            <span className="chalk-strong text-[22px] font-semibold leading-none tracking-[-0.015em] text-waiting">
              <MoneyValue paise={body.amountPaise} />
            </span>
            <span className="text-[12.5px] text-txt-dim">
              promised for <span className="mono text-txt">{body.dateLabel}</span>
            </span>
            <span className="mono ml-auto text-[11.5px] text-txt-faint">
              {body.daysAway} day{body.daysAway === 1 ? "" : "s"} out
            </span>
          </div>
          <Disclosure label="Promise record">
            <Facts rows={body.rows} />
          </Disclosure>
        </>
      );
  }
}

/* ------------------------------------------------------------------ */
/* Pieces                                                              */
/* ------------------------------------------------------------------ */

function Facts({ rows }: { rows: FactRow[] }) {
  return (
    <dl className="space-y-1.5">
      {rows.map((row) => (
        <div key={row.label} className="flex items-baseline gap-3">
          <dt className="w-[124px] shrink-0 text-[11.5px] text-txt-faint">{row.label}</dt>
          <dd
            className={`min-w-0 flex-1 break-words text-[12px] leading-[1.5] ${
              row.mono ? "mono" : ""
            }`}
            style={{ color: row.tone ? TONE_HEX[row.tone] : "var(--color-txt-dim)" }}
          >
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function CheckRow({ check }: { check: PolicyCheck }) {
  const blocked = check.verdict === "block";
  const skipped = check.verdict === "skip";

  return (
    <li className="flex items-start gap-2.5">
      <span
        className="mt-[5px] h-[6px] w-[6px] shrink-0 rounded-[1px]"
        style={{
          backgroundColor: blocked
            ? TONE_HEX.halted
            : skipped
              ? "rgba(255,253,248,0.25)"
              : "var(--color-txt-faint)",
        }}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span
          className={`text-[12.5px] ${blocked ? "text-halted" : skipped ? "text-txt-faint" : "text-txt-dim"}`}
        >
          {check.name}
        </span>
        <span className="ml-2 text-[11.5px] text-txt-faint">{check.note}</span>
      </span>
    </li>
  );
}

function TurnRow({ turn }: { turn: Turn }) {
  const boa = turn.speaker === "BOA";
  return (
    <li className="flex gap-3">
      <span
        className={`mono w-[68px] shrink-0 text-[10.5px] uppercase tracking-[0.06em] ${
          boa ? "text-waiting" : "text-txt-faint"
        }`}
      >
        {boa ? "Boa" : "Customer"}
      </span>
      <span className="min-w-0 flex-1 text-[12.5px] leading-[1.6] text-txt-dim">{turn.text}</span>
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* Voice transport                                                     */
/* ------------------------------------------------------------------ */

/**
 * The call, as a transport.
 *
 * Deliberately labelled: the demo build stitches the TTS turns into one audio
 * file at run time (PRD 7.8), and until that pipeline is wired this control
 * plays the call's *timing* against the transcript rather than pretending to
 * hold a recording. A player that silently plays nothing would be the one
 * dishonest pixel on a page whose whole argument is auditability.
 *
 * The waveform is seeded from the turn text, so a given call always draws the
 * same shape.
 */
function VoicePlayer({ seconds, turns }: { seconds: number; turns: Turn[] }) {
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const frame = useRef<number>(0);

  useEffect(() => {
    if (!playing) return;
    const started = performance.now() - elapsed * 1000;

    const tick = () => {
      const next = (performance.now() - started) / 1000;
      if (next >= seconds) {
        setElapsed(seconds);
        setPlaying(false);
        return;
      }
      setElapsed(next);
      frame.current = requestAnimationFrame(tick);
    };

    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
    // `elapsed` is read once to resume from where it stopped; following it
    // would restart the animation on every frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, seconds]);

  const bars = waveform(turns, 56);
  const progress = elapsed / seconds;

  return (
    <div className="mt-3 flex items-center gap-3.5 border border-white/[0.14] px-3.5 py-3">
      <button
        type="button"
        onClick={() => {
          if (elapsed >= seconds) setElapsed(0);
          setPlaying((p) => !p);
        }}
        aria-label={playing ? "Pause the call" : "Play the call"}
        className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full border border-white/25 text-txt transition-colors hover:border-waiting hover:text-waiting"
      >
        {playing ? (
          <PauseIcon className="h-[11px] w-[11px]" />
        ) : (
          <PlayIcon className="ml-[2px] h-[11px] w-[11px]" />
        )}
      </button>

      <div className="flex h-[26px] min-w-0 flex-1 items-center gap-[2px]" aria-hidden>
        {bars.map((height, i) => (
          <span
            key={i}
            className="wave-bar"
            data-played={i / bars.length <= progress}
            style={{ height: `${height}%` }}
          />
        ))}
      </div>

      <span className="mono shrink-0 text-[11.5px] text-txt-faint">
        {clock(elapsed)} / {clock(seconds)}
      </span>
    </div>
  );
}

function clock(seconds: number): string {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** Deterministic bar heights, so the same call always looks the same. */
function waveform(turns: Turn[], count: number): number[] {
  let h = 2166136261;
  const seed = turns.map((t) => t.text).join("|");
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h ^= h >>> 13;
    // A voice envelope: mostly mid-height with speech peaks, never silent.
    out.push(24 + ((h >>> 0) % 74));
  }
  return out;
}

