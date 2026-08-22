"use client";

import { ChalkNote, ChalkRule } from "@/components/dashboard/chalk";
import { Section } from "@/components/dashboard/primitives";
import {
  CHANNEL_META,
  CHANNEL_ROWS,
  formatClock,
  isQuiet,
  quietSpanMinutes,
  type PolicyPack,
} from "@/lib/policies-data";
import { PipRow, PolicyRow, Stepper, Switch } from "./controls";

/**
 * Contact bounds, quiet hours and mandate discipline (PRD 6.3, page 7 · PRD 9).
 *
 * The three sections that answer "how much, when, and how often" - the bounds
 * that make the workflow a bounded one. Each control carries the count of what
 * it actually did on the last seeded batch, because a cap nobody can see
 * working is indistinguishable from a cap nobody implemented.
 *
 * Those counts are stated as history, not as prediction: they were measured
 * under the saved pack, and the caption says so. A page that recomputed them
 * live as a merchant dragged a number would be inventing an outcome it has no
 * way to know.
 */

type SectionProps = {
  pack: PolicyPack;
  saved: PolicyPack;
  onChange: (next: PolicyPack) => void;
  /** Times each rule fired on the last batch, keyed as in the Evidence Report. */
  firings: Record<string, number>;
};

/* ------------------------------------------------------------------ */
/* Contact bounds                                                      */
/* ------------------------------------------------------------------ */

export function ContactBounds({ pack, saved, onChange, firings }: SectionProps) {
  const { contact } = pack;
  const set = (next: Partial<PolicyPack["contact"]>) =>
    onChange({ ...pack, contact: { ...contact, ...next } });

  const capTotal = CHANNEL_ROWS.reduce(
    (sum, { channel }) => sum + contact.channelCaps[channel],
    0,
  );

  return (
    <Section title="Contact bounds" meta="how much rope one case gets">
      <div className="divide-y divide-white/[0.06]">
        <PolicyRow
          label="Attempts per case"
          changed={contact.maxAttempts !== saved.contact.maxAttempts}
          caption="Every contact counts against this, on every channel. Reaching it closes the case as EXHAUSTED with the count and the reason on the ledger — it does not quietly look for one more thing to try."
          effect={`${firings.attempt_cap ?? 0} cases closed at the cap on the last batch`}
          control={
            <Stepper
              label="Attempts per case"
              value={contact.maxAttempts}
              onChange={(maxAttempts) => set({ maxAttempts })}
              min={1}
              max={8}
              format={(value) => `${value} attempts`}
            />
          }
        >
          <PipRow count={contact.maxAttempts} max={8} />
        </PolicyRow>

        <PolicyRow
          label="Cool-down between contacts"
          changed={contact.coolDownHours !== saved.contact.coolDownHours}
          caption="The minimum gap between two contacts on one case. Twenty hours is deliberately not twenty-four: it lets a nudge that went out at 10:00 be followed the next morning rather than pushed a full day each time. A silent retry contacts nobody and is not held by this."
          effect={`${firings.cool_down ?? 0} contacts deferred by the cool-down on the last batch`}
          control={
            <Stepper
              label="Cool-down hours"
              value={contact.coolDownHours}
              onChange={(coolDownHours) => set({ coolDownHours })}
              min={0}
              max={72}
              step={2}
              format={(value) => (value === 0 ? "none" : `${value}h`)}
            />
          }
        />

        <div className="policy-row px-5 py-3.5">
          <div className="flex items-baseline justify-between gap-4">
            <p className="chalk-hand text-[14px] uppercase tracking-[0.06em] text-txt">
              Per-channel caps
            </p>
            <span className="mono text-[11.5px] text-txt-faint">
              {capTotal} across {CHANNEL_ROWS.length} channels
            </span>
          </div>
          <p className="mt-1.5 max-w-[62ch] text-[11.5px] leading-[1.6] text-txt-faint">
            A cap per channel on top of the total, so four attempts cannot become four phone calls.
            When one is spent the ladder falls to the next allowed channel rather than stalling.
          </p>

          <ul className="mt-3 space-y-2">
            {CHANNEL_ROWS.map(({ channel, silent }) => {
              const cap = contact.channelCaps[channel];
              const dirty = cap !== saved.contact.channelCaps[channel];
              return (
                <li key={channel} className="flex items-center justify-between gap-4">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="text-[12.5px] text-txt-dim">
                      {CHANNEL_META[channel].label}
                    </span>
                    {silent ? (
                      <span className="mono text-[10.5px] uppercase tracking-[0.06em] text-txt-faint">
                        silent
                      </span>
                    ) : null}
                    {dirty ? (
                      <span className="mono text-[10.5px] uppercase tracking-[0.07em] text-waiting">
                        unsaved
                      </span>
                    ) : null}
                  </span>
                  <Stepper
                    label={`${CHANNEL_META[channel].short} cap`}
                    value={cap}
                    onChange={(next) =>
                      set({ channelCaps: { ...contact.channelCaps, [channel]: next } })
                    }
                    min={0}
                    max={4}
                    format={(value) => (value === 0 ? "off" : `${value} max`)}
                  />
                </li>
              );
            })}
          </ul>

          <p className="mt-3 text-[11.5px] leading-[1.6] text-txt-faint">
            Voice is capped at one. A second call to someone who did not answer the first is not a
            follow-up.
          </p>
          <p className="mono mt-2 text-[11px] leading-[1.5] text-txt-dim">
            {firings.channel_cap ?? 0} actions fell to another channel on the last batch
          </p>
        </div>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Quiet hours                                                         */
/* ------------------------------------------------------------------ */

/**
 * The window nothing goes out in (PRD 9.1).
 *
 * Drawn as a day rather than typed as two times. The rule a merchant is
 * actually setting is "how much of the night is off limits", and two clock
 * fields make that a subtraction they have to do in their head - the band
 * makes it the shape on the screen.
 */
export function QuietHours({ pack, saved, onChange, firings }: SectionProps) {
  const { quiet } = pack;
  const set = (next: Partial<PolicyPack["quiet"]>) =>
    onChange({ ...pack, quiet: { ...quiet, ...next } });

  const blocked = quietSpanMinutes(quiet.startMinutes, quiet.endMinutes);
  const startDirty = quiet.startMinutes !== saved.quiet.startMinutes;
  const endDirty = quiet.endMinutes !== saved.quiet.endMinutes;

  return (
    <Section
      title="Quiet hours"
      meta={`${formatClock(quiet.endMinutes)} – ${formatClock(quiet.startMinutes)} allowed`}
    >
      <div className="px-5 pb-4 pt-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="chalk-hand text-[14px] uppercase tracking-[0.06em] text-txt">
            The day, and the part of it that is off limits
          </p>
          <ChalkNote tone="gold">TRAI DND-aligned</ChalkNote>
        </div>

        <div className="mt-3">
          <DayBand startMinutes={quiet.startMinutes} endMinutes={quiet.endMinutes} />
          <div className="mono mt-1.5 flex justify-between text-[10px] text-txt-faint">
            <span>00:00</span>
            <span>06:00</span>
            <span>12:00</span>
            <span>18:00</span>
            <span>24:00</span>
          </div>
        </div>

        <p className="mt-3 max-w-[62ch] text-[11.5px] leading-[1.6] text-txt-faint">
          Nothing reaches a customer inside the amber stretch —{" "}
          {Math.round(blocked / 60)} hours of every day. A planned action that lands in the window
          is not dropped and it is not sent anyway: it is rescheduled to{" "}
          {formatClock(quiet.endMinutes)} and the deferral is written to the ledger.
        </p>
      </div>

      <ChalkRule />

      <div className="divide-y divide-white/[0.06]">
        <PolicyRow
          label="Window opens"
          changed={endDirty}
          caption="The first minute of the day a message may go out."
          control={
            <Stepper
              label="Quiet hours end"
              value={quiet.endMinutes}
              onChange={(endMinutes) => set({ endMinutes })}
              min={5 * 60}
              max={12 * 60}
              step={30}
              format={formatClock}
            />
          }
        />

        <PolicyRow
          label="Window closes"
          changed={startDirty}
          caption="After this nothing further leaves the building until the window opens again."
          effect={`${firings.quiet_hours ?? 0} actions deferred on the last batch · 0 sent inside the window`}
          control={
            <Stepper
              label="Quiet hours start"
              value={quiet.startMinutes}
              onChange={(startMinutes) => set({ startMinutes })}
              min={17 * 60}
              max={23 * 60 + 30}
              step={30}
              format={formatClock}
            />
          }
        />

        <PolicyRow
          label="Silent retries exempt"
          changed={quiet.exemptSilentRetries !== saved.quiet.exemptSilentRetries}
          off={!quiet.exemptSilentRetries}
          caption="Re-presenting a payment to the gateway wakes nobody up. Holding it until morning costs recovery and protects no one — the nuance is worth stating rather than assuming."
          control={
            <Switch
              label="Silent retries exempt from quiet hours"
              on={quiet.exemptSilentRetries}
              onChange={(exemptSilentRetries) => set({ exemptSilentRetries })}
            />
          }
        />
      </div>
    </Section>
  );
}

/** Forty-eight half-hour marks. Amber is blocked; the boundary marks are white. */
function DayBand({ startMinutes, endMinutes }: { startMinutes: number; endMinutes: number }) {
  const ticks = Array.from({ length: 48 }, (_, i) => i * 30);
  const lastQuiet = ((endMinutes - 30) % 1440 + 1440) % 1440;

  return (
    <div
      className="day-band"
      role="img"
      aria-label={`Contact blocked from ${formatClock(startMinutes)} to ${formatClock(endMinutes)} IST`}
    >
      {ticks.map((minute) => {
        const quiet = isQuiet(minute, startMinutes, endMinutes);
        return (
          <span
            key={minute}
            className="day-tick"
            data-quiet={quiet}
            data-edge={quiet && (minute === startMinutes % 1440 || minute === lastQuiet)}
          />
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Mandate re-presentation                                             */
/* ------------------------------------------------------------------ */

/**
 * Mandate retry rules (PRD 9.7).
 *
 * A failed auto-debit is the one leak where retrying is the whole
 * intervention, which makes it the one place where an unbounded agent does
 * real damage: re-presenting a mandate every morning is how a merchant
 * collects bank penalties on their customer's behalf.
 */
export function MandateRules({ pack, saved, onChange, firings }: SectionProps) {
  const { mandate } = pack;
  const set = (next: Partial<PolicyPack["mandate"]>) =>
    onChange({ ...pack, mandate: { ...mandate, ...next } });

  return (
    <Section title="Mandate re-presentation" meta="RBI e-mandate discipline">
      <div className="divide-y divide-white/[0.06]">
        <PolicyRow
          label="Re-presentations per cycle"
          changed={mandate.maxPerCycle !== saved.mandate.maxPerCycle}
          caption="How many times one billing cycle's failed debit may be presented again. At the cap the case waits for the next cycle rather than continuing to hammer the account."
          effect={`${firings.mandate_cap ?? 0} mandates held to the next cycle on the last batch`}
          control={
            <Stepper
              label="Re-presentations per cycle"
              value={mandate.maxPerCycle}
              onChange={(maxPerCycle) => set({ maxPerCycle })}
              min={1}
              max={5}
              format={(value) => `${value} per cycle`}
            />
          }
        >
          <PipRow count={mandate.maxPerCycle} max={5} />
        </PolicyRow>

        <PolicyRow
          label="Spacing between presentations"
          changed={mandate.spacingDays !== saved.mandate.spacingDays}
          caption="Clear days between one presentation and the next. Same-day re-presentation against an account that just bounced earns the customer a second failure fee and the merchant nothing."
          control={
            <Stepper
              label="Spacing days"
              value={mandate.spacingDays}
              onChange={(spacingDays) => set({ spacingDays })}
              min={1}
              max={10}
              format={(value) => `${value} day${value === 1 ? "" : "s"}`}
            />
          }
        />

        <PolicyRow
          label="Align retries to payday"
          changed={mandate.alignToPayday !== saved.mandate.alignToPayday}
          off={!mandate.alignToPayday}
          caption="Most mandate failures are insufficient funds, not cancelled mandates. Presenting inside the salary window instead of the next morning is the same attempt spent at a moment it can actually clear."
          control={
            <Switch
              label="Align mandate retries to the payday window"
              on={mandate.alignToPayday}
              onChange={(alignToPayday) => set({ alignToPayday })}
            />
          }
        />
      </div>
    </Section>
  );
}
