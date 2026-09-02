"use client";

import { useCallback, useEffect, useRef, useState, type ComponentType, type ReactNode, type SVGProps } from "react";

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
import { stampOf } from "@/lib/clock";
import {
  CHANNEL_META,
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
  // Red, like every other block: a message the provider refused to deliver is
  // a stop, not a step, and the timeline should read as one.
  DELIVERY_FAILED: { Icon: HaltIcon, tone: "halted" },
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
          <VoicePlayer
            seconds={body.seconds}
            turns={body.transcript}
            audioUrl={body.audioUrl ?? null}
            recording={body.recording ?? null}
          />
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
 * The call, played.
 *
 * This control used to move a waveform and a clock and make no sound at all -
 * honest in its comment, useless in a demo, and the one thing a judge asked
 * for that the product could not do. It speaks the transcript now, through the
 * browser's own speech synthesis, in a Hindi voice where the machine has one.
 *
 * What it is *not* is a recording, and the label says so. The production
 * pipeline (PRD 7.8) stitches per-turn TTS into one audio file server-side and
 * stores it against the case; until that lands, synthesising the same
 * transcript on the client is the closest thing to it that is not a lie. A
 * machine with no speech voices installed falls back to the silent transport
 * and says which one it is doing.
 *
 * The waveform is seeded from the turn text, so a given call always draws the
 * same shape.
 */
function VoicePlayer({
  seconds,
  turns,
  audioUrl,
  recording,
}: {
  seconds: number;
  turns: Turn[];
  /** Set when the API holds a recording — stitched for a simulated call, or the real call's (D-144). */
  audioUrl: string | null;
  /** The API's own description of that recording. */
  recording: string | null;
}) {
  // A stored recording, when there is one. Still not a phone call — telephony
  // is simulated and labelled — but it is the same audio for every listener,
  // rendered once by the API from the transcript, which the browser-side
  // synthesis below never was.
  if (audioUrl) {
    return <RecordingPlayer src={mediaSrc(audioUrl)} seconds={seconds} turns={turns} recording={recording} />;
  }

  return <SynthesisedPlayer seconds={seconds} turns={turns} />;
}

/**
 * The recording is fetched through the Control Tower's own origin. The API's
 * media route is behind the session guard, and a browser will not send one
 * site's httpOnly cookie to another; the BFF route reads it and streams the
 * file back same-origin (D-147). A URL that is not a recording of ours is
 * left alone.
 */
function mediaSrc(audioUrl: string): string {
  const match = /\/media\/voice\/([A-Za-z0-9_-]{1,80}\.(?:mp3|wav))$/.exec(audioUrl);
  return match ? `/api/media/voice/${match[1]}` : audioUrl;
}

function RecordingPlayer({
  src,
  seconds,
  turns,
  recording,
}: {
  src: string;
  seconds: number;
  turns: Turn[];
  recording: string | null;
}) {
  // The same chrome as the synthesised player — one play button, the call's
  // bars, one clock — driving a real <audio> element instead of the speech
  // engine, so a stored recording and a synthesised one read as one control.
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [length, setLength] = useState(seconds);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = audio.current;
    return () => {
      el?.pause();
    };
  }, []);

  const toggle = () => {
    const el = audio.current;
    if (!el) return;
    if (playing) {
      el.pause();
      return;
    }
    if (el.ended || (length > 0 && el.currentTime >= length)) el.currentTime = 0;
    void el.play().catch(() => setFailed(true));
  };

  const seek = (fraction: number) => {
    const el = audio.current;
    if (!el || !Number.isFinite(length) || length <= 0) return;
    el.currentTime = Math.max(0, Math.min(length, fraction * length));
    setElapsed(el.currentTime);
  };

  const bars = waveform(turns, 56);
  const progress = length > 0 ? elapsed / length : 0;
  const real = /Twilio/.test(recording ?? "");

  return (
    <div className="mt-3">
      <audio
        ref={audio}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(event) => setElapsed(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => {
          const known = event.currentTarget.duration;
          if (Number.isFinite(known) && known > 0) setLength(known);
        }}
        onError={() => setFailed(true)}
      >
        <track kind="captions" />
      </audio>

      <div className="flex items-center gap-3.5 border border-white/[0.14] px-3.5 py-3">
        <button
          type="button"
          onClick={toggle}
          aria-label={playing ? "Pause the recording" : "Play the recording"}
          className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full border border-white/25 text-txt transition-colors hover:border-waiting hover:text-waiting"
        >
          {playing ? (
            <PauseIcon className="h-[11px] w-[11px]" />
          ) : (
            <PlayIcon className="ml-[2px] h-[11px] w-[11px]" />
          )}
        </button>

        {/* Click anywhere on the bars to scrub; a stored recording can. */}
        <div
          className="flex h-[26px] min-w-0 flex-1 cursor-pointer items-center gap-[2px]"
          role="slider"
          aria-label="Recording position"
          aria-valuemin={0}
          aria-valuemax={Math.round(length)}
          aria-valuenow={Math.round(elapsed)}
          tabIndex={0}
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            seek((event.clientX - box.left) / Math.max(1, box.width));
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight") seek(Math.min(1, progress + 0.05));
            if (event.key === "ArrowLeft") seek(Math.max(0, progress - 0.05));
            if (event.key === " " || event.key === "Enter") {
              event.preventDefault();
              toggle();
            }
          }}
        >
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
          {clock(elapsed)} / {clock(length)}
        </span>
      </div>

      <p className="mt-1.5 text-[11px] leading-[1.5] text-txt-faint">
        {failed
          ? "The recording could not be loaded. Sign in again if the session has expired; the transcript below is complete either way."
          : real
            ? `${recording} (${clock(length)}). A real call to the customer's phone; the transcript below is what speech recognition heard.`
            : `Synthesised recording rendered server-side from the transcript below (${clock(length)} of simulated call) — not a phone call. Telephony on this case was simulated and labelled.`}
      </p>
    </div>
  );
}

function SynthesisedPlayer({ seconds, turns }: { seconds: number; turns: Turn[] }) {
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [voiceName, setVoiceName] = useState<string | null>(null);
  const frame = useRef<number>(0);
  const voice = useRef<SpeechSynthesisVoice | null>(null);

  /*
   * Voice selection, after mount.
   *
   * `speechSynthesis.getVoices()` is empty until the engine has enumerated,
   * which is why this listens for `voiceschanged` rather than reading once -
   * and why support is state rather than something read during render, where
   * touching `window` would be a hydration mismatch.
   */
  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const synth = window.speechSynthesis;

    const pick = () => {
      const voices = synth.getVoices();
      if (voices.length === 0) return;
      const hindi = voices.find((v) => v.lang?.toLowerCase().startsWith("hi"));
      const indian = voices.find((v) => v.lang?.toLowerCase() === "en-in");
      const chosen = hindi ?? indian ?? voices[0] ?? null;
      voice.current = chosen;
      setVoiceName(chosen ? chosen.name : null);
    };

    pick();
    synth.addEventListener("voiceschanged", pick);
    return () => {
      synth.removeEventListener("voiceschanged", pick);
      synth.cancel();
    };
  }, []);

  const stop = useCallback(() => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    setPlaying(false);
  }, []);

  // Leaving the case must not leave a voice talking to an empty room.
  useEffect(() => stop, [stop]);

  useEffect(() => {
    if (!playing) return;
    const started = performance.now() - elapsed * 1000;

    const tick = () => {
      const next = (performance.now() - started) / 1000;
      if (next >= seconds) {
        setElapsed(seconds);
        stop();
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
  }, [playing, seconds, stop]);

  const toggle = () => {
    const synth =
      typeof window !== "undefined" && "speechSynthesis" in window
        ? window.speechSynthesis
        : null;

    if (playing) {
      synth?.cancel();
      setPlaying(false);
      return;
    }

    if (elapsed >= seconds) setElapsed(0);
    setPlaying(true);

    if (!synth || !voice.current) return;

    // Queued as one utterance per turn, so the two speakers are audibly
    // different and the pauses fall where the conversation's pauses were.
    synth.cancel();
    turns.forEach((turn, i) => {
      const said = new SpeechSynthesisUtterance(turn.text);
      said.lang = voice.current?.lang ?? "hi-IN";
      said.rate = 0.98;
      // Two speakers, audibly apart, without needing two installed voices.
      said.pitch = turn.speaker === "BOA" ? 1.02 : 0.86;
      // Naming a specific voice is an optimisation, not a requirement: some
      // engines reject the assignment, and losing the whole call because the
      // preferred voice would not take is worse than losing the accent.
      try {
        said.voice = voice.current;
      } catch {
        // Falls back to the engine's default for `lang`.
      }
      if (i === turns.length - 1) {
        said.onend = () => setPlaying(false);
      }
      synth.speak(said);
    });
  };

  const bars = waveform(turns, 56);
  const progress = elapsed / seconds;

  return (
    <div className="mt-3">
      <div className="flex items-center gap-3.5 border border-white/[0.14] px-3.5 py-3">
        <button
          type="button"
          onClick={toggle}
          aria-label={playing ? "Stop the call" : "Play the call"}
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

      {/* What a listener is actually hearing. */}
      <p className="mt-1.5 text-[11px] leading-[1.5] text-txt-faint">
        {voiceName
          ? `Spoken here by your browser's speech synthesis (${voiceName}) from the transcript below — not a stored recording. Production stitches per-turn TTS server-side and files it against the case.`
          : "No speech voice available in this browser, so this plays the call's timing against the transcript rather than pretending to hold a recording."}
      </p>
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

