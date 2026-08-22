"use client";

import Link from "next/link";

import { ChalkRule } from "@/components/dashboard/chalk";
import { TONE_HEX } from "@/lib/dashboard-data";
import { formatRupees } from "@/lib/money";
import {
  CHANNEL_META,
  CHANNEL_ROWS,
  ESCALATION_GATES,
  OPT_OUT_KEYWORDS,
  STOPPING_RULES,
  type PolicyPack,
} from "@/lib/policies-data";
import { Section } from "@/components/dashboard/primitives";
import { PolicyRow, Stepper, Switch } from "./controls";

/**
 * Stopping rules, escalation gates and channels (PRD 6.3, page 7 · PRD 9).
 *
 * The three sections that answer "and when does it stop" - the half of the
 * policy that is about not acting. Rules that end a case, gates that hand it
 * to a person, and the channels any of it may use at all.
 *
 * One switch on this page does not move, and that is the point of the page:
 * an opt-out cannot be traded away by a merchant having a bad quarter, so the
 * UI has no affordance for it rather than a confirmation dialog in front of it.
 */

type SectionProps = {
  pack: PolicyPack;
  saved: PolicyPack;
  onChange: (next: PolicyPack) => void;
  firings: Record<string, number>;
};

/* ------------------------------------------------------------------ */
/* Stopping rules                                                      */
/* ------------------------------------------------------------------ */

export function StoppingRules({ pack, saved, onChange, firings }: SectionProps) {
  const locked = STOPPING_RULES.filter((rule) => rule.locked).length;
  const on = STOPPING_RULES.filter((rule) => pack.rules[rule.key]).length;

  return (
    <Section
      title="Stopping rules"
      meta={`${on} of ${STOPPING_RULES.length} on · ${locked} locked`}
    >
      <div className="divide-y divide-white/[0.06]">
        {STOPPING_RULES.map((rule) => {
          const enabled = pack.rules[rule.key];
          const fired = firings[rule.firingKey] ?? 0;

          return (
            <div key={rule.key}>
              <PolicyRow
                label={rule.label}
                locked={rule.locked}
                changed={enabled !== saved.rules[rule.key]}
                off={!enabled}
                caption={rule.explain}
                effect={
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span style={{ color: TONE_HEX[rule.tone] }}>{rule.effect}</span>
                    <span className="text-txt-faint">
                      · fired {fired} {fired === 1 ? "time" : "times"} on the last batch
                    </span>
                  </span>
                }
                control={
                  <Switch
                    label={rule.label}
                    on={enabled}
                    locked={rule.locked}
                    onChange={(next) =>
                      onChange({ ...pack, rules: { ...pack.rules, [rule.key]: next } })
                    }
                  />
                }
              >
                {rule.key === "opt_out" ? (
                  <div>
                    <p className="text-[11.5px] leading-[1.6] text-txt-faint">
                      Non-negotiable. There is no configuration of this product in which a customer
                      who asked to be left alone is contacted again — the switch is drawn rather
                      than removed so that is visible rather than merely true.
                    </p>
                    <ul className="mt-2.5 flex flex-wrap gap-1.5">
                      {OPT_OUT_KEYWORDS.map((word) => (
                        <li key={word} className="policy-chip">
                          {word}
                        </li>
                      ))}
                      <li className="policy-chip text-txt-dim">+ transliterations</li>
                    </ul>
                  </div>
                ) : null}

                {rule.key === "sentiment" && enabled ? (
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="text-[11.5px] leading-[1.55] text-txt-faint">
                      Halt when the classifier is at least this sure the reply is hostile. Lower is
                      more cautious — it stops on replies it is less certain about.
                    </span>
                    <Stepper
                      label="Sentiment halt threshold"
                      value={pack.sentimentThreshold}
                      onChange={(sentimentThreshold) => onChange({ ...pack, sentimentThreshold })}
                      min={0.4}
                      max={0.95}
                      step={0.05}
                      format={(value) => value.toFixed(2)}
                    />
                  </div>
                ) : null}

                {!enabled && rule.offWarning ? (
                  <p
                    className="border-l-2 pl-3 text-[11.5px] leading-[1.6]"
                    style={{
                      borderColor: TONE_HEX.halted,
                      color: "var(--color-halted)",
                    }}
                  >
                    {rule.offWarning}
                  </p>
                ) : null}
              </PolicyRow>
            </div>
          );
        })}
      </div>

      <ChalkRule />

      <p className="px-5 pb-4 pt-3 text-[11.5px] leading-[1.6] text-txt-faint">
        Every rule here ends a case rather than deferring an action. The Evidence Report counts each
        one separately, including the ones that never fired — a guardrail list that only shows the
        rules that caught something is a highlight reel.
      </p>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Escalation gates                                                    */
/* ------------------------------------------------------------------ */

/**
 * What the agent may not do alone (PRD 9.6).
 *
 * Each row here is a reason a card appears in the Approvals Queue, and the
 * live count beside it is that queue - counted from the same requests rather
 * than kept alongside them, so the two pages cannot drift into disagreeing
 * about how many things are waiting on a person.
 */
export function EscalationGates({
  pack,
  saved,
  onChange,
  queue,
}: Omit<SectionProps, "firings"> & {
  /** Requests currently waiting, per gate id. */
  queue: Record<string, number>;
}) {
  const { escalation } = pack;
  const set = (next: Partial<PolicyPack["escalation"]>) =>
    onChange({ ...pack, escalation: { ...escalation, ...next } });

  const waiting = Object.values(queue).reduce((sum, n) => sum + n, 0);

  return (
    <Section
      title="Escalation gates"
      action={
        <Link href="/approvals" className="disclose">
          {waiting} waiting on a human →
        </Link>
      }
    >
      <div className="divide-y divide-white/[0.06]">
        {ESCALATION_GATES.map((gate) => {
          const pending = gate.queueGate ? (queue[gate.queueGate] ?? 0) : 0;
          const effect =
            pending > 0 ? (
              <Link href="/approvals" className="text-waiting hover:text-txt">
                {pending} {pending === 1 ? "request is" : "requests are"} held by this gate right
                now →
              </Link>
            ) : gate.queueGate ? (
              "Nothing is held by this gate at the moment"
            ) : undefined;

          switch (gate.key) {
            case "discount":
              return (
                <PolicyRow
                  key={gate.key}
                  label={gate.label}
                  locked
                  changed={
                    escalation.discountCapPercent !== saved.escalation.discountCapPercent
                  }
                  caption={gate.explain}
                  effect={effect}
                  control={<Switch label={gate.label} on locked onChange={() => {}} />}
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="text-[11.5px] leading-[1.55] text-txt-faint">
                      The ceiling on what a human may approve. It bounds the person, not the agent
                      — the agent&apos;s ceiling is zero and is not configurable.
                    </span>
                    <Stepper
                      label="Discount a human may approve"
                      value={escalation.discountCapPercent}
                      onChange={(discountCapPercent) => set({ discountCapPercent })}
                      min={0}
                      max={40}
                      step={5}
                      format={(value) => `${value}% cap`}
                    />
                  </div>
                </PolicyRow>
              );

            case "value_threshold":
              return (
                <PolicyRow
                  key={gate.key}
                  label={gate.label}
                  changed={
                    escalation.valueThresholdPaise !== saved.escalation.valueThresholdPaise
                  }
                  caption={gate.explain}
                  effect={effect}
                  control={
                    <Stepper
                      label="Escalation value threshold"
                      value={escalation.valueThresholdPaise}
                      onChange={(valueThresholdPaise) => set({ valueThresholdPaise })}
                      min={5_000 * 100}
                      max={200_000 * 100}
                      step={5_000 * 100}
                      format={(paise) => `₹${formatRupees(paise)}`}
                    />
                  }
                />
              );

            case "b2b_always":
              return (
                <PolicyRow
                  key={gate.key}
                  label={gate.label}
                  changed={escalation.b2bAlways !== saved.escalation.b2bAlways}
                  off={!escalation.b2bAlways}
                  caption={gate.explain}
                  control={
                    <Switch
                      label={gate.label}
                      on={escalation.b2bAlways}
                      onChange={(b2bAlways) => set({ b2bAlways })}
                    />
                  }
                />
              );

            case "confidence_floor":
              return (
                <PolicyRow
                  key={gate.key}
                  label={gate.label}
                  changed={escalation.confidenceFloor !== saved.escalation.confidenceFloor}
                  caption={gate.explain}
                  effect={effect}
                  control={
                    <Stepper
                      label="Diagnosis confidence floor"
                      value={escalation.confidenceFloor}
                      onChange={(confidenceFloor) => set({ confidenceFloor })}
                      min={0.3}
                      max={0.9}
                      step={0.05}
                      format={(value) => value.toFixed(2)}
                    />
                  }
                />
              );

            default:
              return (
                <PolicyRow
                  key={gate.key}
                  label={gate.label}
                  changed={escalation.hardship !== saved.escalation.hardship}
                  off={!escalation.hardship}
                  caption={gate.explain}
                  effect={effect}
                  control={
                    <Switch
                      label={gate.label}
                      on={escalation.hardship}
                      onChange={(hardship) => set({ hardship })}
                    />
                  }
                />
              );
          }
        })}
      </div>

      <ChalkRule />

      <p className="px-5 pb-4 pt-3 text-[11.5px] leading-[1.6] text-txt-faint">
        A gated action is planned in full, checked, and then stopped — the exact message that would
        have gone out is what a merchant approves or rejects. Approving releases that one action; it
        does not widen any bound on this page.
      </p>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Channels                                                            */
/* ------------------------------------------------------------------ */

/**
 * What the agent may reach a customer through, and whether that reach is real.
 *
 * The mode indicator is the important column. Three of these send something a
 * person actually receives; the fourth is synthesised at demo time and says so
 * here rather than in a footnote of the README.
 */
export function Channels({
  pack,
  saved,
  onChange,
}: Omit<SectionProps, "firings">) {
  const live = CHANNEL_ROWS.filter(({ channel }) => pack.channels[channel]).length;

  return (
    <Section title="Channels" meta={`${live} of ${CHANNEL_ROWS.length} enabled`}>
      <div className="divide-y divide-white/[0.06]">
        {CHANNEL_ROWS.map(({ channel, silent, note }) => {
          const enabled = pack.channels[channel];
          const meta = CHANNEL_META[channel];
          return (
            <PolicyRow
              key={channel}
              label={
                <span className="flex items-baseline gap-2">
                  {meta.label}
                  {silent ? (
                    <span className="mono text-[10.5px] uppercase tracking-[0.06em] text-txt-faint">
                      not a contact
                    </span>
                  ) : null}
                </span>
              }
              changed={enabled !== saved.channels[channel]}
              off={!enabled}
              caption={note}
              effect={
                <span className="flex flex-wrap items-center gap-2">
                  <span className="policy-chip">{meta.mode}</span>
                  <span className="text-txt-faint">
                    cap {pack.contact.channelCaps[channel]} per case
                  </span>
                </span>
              }
              control={
                <Switch
                  label={`${meta.label} channel`}
                  on={enabled}
                  onChange={(next) =>
                    onChange({ ...pack, channels: { ...pack.channels, [channel]: next } })
                  }
                />
              }
            />
          );
        })}
      </div>

      <ChalkRule />

      <p className="px-5 pb-4 pt-3 text-[11.5px] leading-[1.6] text-txt-faint">
        Switching a channel off removes it from every playbook ladder at the next planning step.
        Cases already mid-ladder fall through to the next allowed channel rather than stalling — and
        a case with no channels left closes as exhausted rather than sitting open forever.
      </p>
    </Section>
  );
}
