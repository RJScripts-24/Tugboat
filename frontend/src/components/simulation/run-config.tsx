"use client";

import type { ReactNode } from "react";

import { ChalkNote, ChalkRule, ChalkStroke, ChalkTrack } from "@/components/dashboard/chalk";
import { CheckIcon, LockIcon } from "@/components/dashboard/icons";
import { Section } from "@/components/dashboard/primitives";
import {
  ARM_META,
  ARM_ORDER,
  BATCH_SIZES,
  CASE_TYPE_META,
  DIFFICULTY,
  DIFFICULTY_ORDER,
  type ArmKey,
  type SimulationConfig,
} from "@/lib/simulation-data";
import { CASE_TYPE_ORDER, type CaseType } from "@/lib/pipeline-data";

/**
 * State A of the Simulation Lab (PRD 6.3, page 6) - what the batch is made of
 * before anyone presses go.
 *
 * Every control here is one of the four levers that can move the headline
 * number: how many cases, what kind, how willing the customers are, and which
 * policy is in charge. They are on the page rather than in a config file
 * because a headline whose assumptions are hidden is a headline that means
 * nothing - and the difficulty preset in particular states its response-rate
 * assumption in the label, where a reader cannot miss it.
 *
 * The mix sliders are weights, not percentages. Four inputs that must sum to
 * 100 is four inputs that fight the person moving them; these are normalised
 * for display, so the shares always total 100 and the case counts underneath
 * are the batch that would actually be generated.
 */
export function RunConfig({
  config,
  onChange,
  disabled = false,
}: {
  config: SimulationConfig;
  onChange: (next: SimulationConfig) => void;
  disabled?: boolean;
}) {
  const weight = CASE_TYPE_ORDER.reduce((sum, type) => sum + config.mix[type], 0);
  const shareOf = (type: CaseType) => (weight === 0 ? 0 : config.mix[type] / weight);
  const preset = DIFFICULTY[config.difficulty];

  const toggleArm = (key: ArmKey) => {
    if (ARM_META[key].locked) return;
    onChange({
      ...config,
      arms: config.arms.includes(key)
        ? config.arms.filter((arm) => arm !== key)
        : ARM_ORDER.filter((arm) => arm === key || config.arms.includes(arm)),
    });
  };

  return (
    <Section title="Batch configuration" meta={`${config.arms.length} arms · one seed`}>
      <div className="space-y-4 px-5 pb-5 pt-4">
        {/* ---------------------------------------------------------- */}
        <Field
          label="Batch size"
          value={<span className="mono text-[13px] text-txt">{config.batchSize} cases</span>}
          caption="200 or more is what the bar asks for. Below that a recovery rate is an anecdote."
        >
          <div className="flex flex-wrap gap-2">
            {BATCH_SIZES.map((size) => (
              <button
                key={size}
                type="button"
                className="filter-control"
                data-active={config.batchSize === size}
                disabled={disabled}
                onClick={() => onChange({ ...config, batchSize: size })}
              >
                {size}
              </button>
            ))}
          </div>
        </Field>

        <ChalkRule />

        {/* ---------------------------------------------------------- */}
        <Field
          label="Case mix"
          value={<span className="meta">{weight === 0 ? "—" : "100%"}</span>}
          caption="The four ways revenue leaks. Mandates recover cheaply and invoices carry the money, so the mix moves the headline as much as the policy does."
        >
          <div className="space-y-2.5">
            {CASE_TYPE_ORDER.map((type) => {
              const share = shareOf(type);
              const cases = Math.round(share * config.batchSize);
              return (
                <div key={type} className="grid grid-cols-[132px_1fr_84px] items-center gap-3">
                  <label
                    htmlFor={`mix-${type}`}
                    className="text-[12.5px] leading-none text-txt-dim"
                  >
                    {CASE_TYPE_META[type].label}
                  </label>
                  <input
                    id={`mix-${type}`}
                    type="range"
                    className="chalk-range"
                    min={0}
                    max={100}
                    step={0.1}
                    value={config.mix[type]}
                    disabled={disabled}
                    onChange={(event) =>
                      onChange({
                        ...config,
                        mix: { ...config.mix, [type]: Number(event.target.value) },
                      })
                    }
                  />
                  <span className="mono text-right text-[11.5px] text-txt-faint">
                    <span className="text-txt-dim">{(share * 100).toFixed(1)}%</span> · {cases}
                  </span>
                </div>
              );
            })}
          </div>
        </Field>

        <ChalkRule />

        {/* ---------------------------------------------------------- */}
        <Field
          label="Difficulty"
          value={
            <span className="mono text-[12px] text-txt-faint">
              {(preset.responseRate * 100).toFixed(0)}% respond
            </span>
          }
          caption={preset.caption}
        >
          <div className="flex flex-wrap gap-2">
            {DIFFICULTY_ORDER.map((key) => (
              <button
                key={key}
                type="button"
                className="filter-control"
                data-active={config.difficulty === key}
                disabled={disabled}
                onClick={() => onChange({ ...config, difficulty: key })}
              >
                {DIFFICULTY[key].label}
              </button>
            ))}
          </div>
        </Field>

        <ChalkRule />

        {/* ---------------------------------------------------------- */}
        <Field
          label="Seed"
          value={
            <ChalkNote tone="gold">rerun this seed and get identical numbers</ChalkNote>
          }
          caption="The seed fixes the batch, the personas and their ground-truth causes. Every arm below is run against that same batch, which is what makes comparing them mean anything."
        >
          <div className="flex flex-wrap items-center gap-2.5">
            <input
              type="number"
              className="seed-field"
              value={config.seed}
              min={0}
              max={99_999}
              disabled={disabled}
              aria-label="Random seed"
              onChange={(event) =>
                onChange({ ...config, seed: Math.max(0, Number(event.target.value) || 0) })
              }
            />
            <button
              type="button"
              className="btn-op-quiet"
              disabled={disabled || config.seed === 42}
              onClick={() => onChange({ ...config, seed: 42 })}
            >
              Reset to 42
            </button>
          </div>
        </Field>

        <ChalkRule />

        {/* ---------------------------------------------------------- */}
        <Field
          label="Policy arms"
          value={<span className="meta">run on the same seed</span>}
          caption="Three policies over one batch. The uplift between the first and the last is the claim; the middle one is the control that stops the claim being about effort."
        >
          <div className="space-y-1">
            {ARM_ORDER.map((key) => {
              const arm = ARM_META[key];
              const on = config.arms.includes(key);
              return (
                <button
                  key={key}
                  type="button"
                  className="reason-option"
                  data-selected={on}
                  disabled={disabled || arm.locked}
                  aria-pressed={on}
                  onClick={() => toggleArm(key)}
                >
                  <span className="mt-[3px] flex h-[13px] w-[13px] shrink-0 items-center justify-center rounded-[2px] border border-white/25">
                    {on ? <CheckIcon className="h-[9px] w-[9px] text-txt" /> : null}
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-2 text-[12.5px] text-txt">
                      {arm.label}
                      {arm.locked ? (
                        <span className="inline-flex items-center gap-1 text-[10.5px] uppercase tracking-[0.06em] text-txt-faint">
                          <LockIcon className="h-[10px] w-[10px]" />
                          under test
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-1 block text-[11.5px] leading-[1.55] text-txt-faint">
                      {arm.caption}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </Field>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */

function Field({
  label,
  value,
  caption,
  children,
}: {
  label: string;
  value?: ReactNode;
  caption: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <p className="chalk-hand text-[14px] uppercase tracking-[0.07em] text-txt">{label}</p>
        {value}
      </div>
      {children}
      <p className="mt-2.5 text-[11.5px] leading-[1.55] text-txt-faint">{caption}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * The answer to the only question that matters about a self-graded batch:
 * why should anyone believe it (PRD 6.3, page 6 · the harness in PRD 8).
 *
 * Written as four things that are true about the harness rather than four
 * claims about its quality. The last one is the important one - the headline
 * is a difference between two arms, so a generous simulator inflates both and
 * cancels out of the number being reported.
 */
export function HonestyCard({
  atRiskPaise,
  cases,
  contacts,
}: {
  atRiskPaise: number;
  cases: number;
  contacts: number;
}) {
  return (
    <Section title="How this stays honest" meta="read before the numbers">
      <div className="space-y-4 px-5 pb-5 pt-4">
        <Bullet n="01" title="The agent never sees the persona">
          Each synthetic customer has a responsiveness, a funds window, a channel preference and a
          tolerance for being chased. The agent gets what a real integration would get — an error
          code, an amount, a history — and nothing else.
        </Bullet>

        <Bullet n="02" title="Ground truth is held by the grader, not the agent">
          The simulator knows why every payment really failed. That column is used once, after the
          run, to mark the diagnoses. Nothing upstream of the report can read it.
        </Bullet>

        <Bullet n="03" title="One seed, three policies, identical batch">
          The same {cases} cases and the same {formatPlain(atRiskPaise)} rupees at risk are put in
          front of all three arms. They differ in what they are allowed to do, and in nothing else.
        </Bullet>

        <Bullet n="04" title="The headline is a difference, not a total">
          A generous simulator lifts the baseline as much as it lifts the agent, so it cancels out
          of the uplift. That is the number this page leads with — and the naive arm is there to
          show that {contacts.toLocaleString("en-IN")} bounded contacts beat three times as many
          unbounded ones.
        </Bullet>

        <div className="pt-0.5">
          <ChalkRule />
          <p className="mt-3 text-[11.5px] leading-[1.6] text-txt-faint">
            Residual non-determinism is documented rather than denied: diagnosis is a rules table
            first (ADR-5), so four causes in five never reach a model at all, and the calls that do
            run at temperature 0 against cached persona scripts.
          </p>
        </div>
      </div>
    </Section>
  );
}

function Bullet({ n, title, children }: { n: string; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-3.5">
      <span className="mono mt-[2px] shrink-0 text-[11px] text-txt-faint">{n}</span>
      <span className="min-w-0">
        <span className="block text-[13px] leading-[1.5] text-txt">{title}</span>
        <span className="mt-1 block text-[12px] leading-[1.6] text-txt-dim">{children}</span>
      </span>
    </div>
  );
}

function formatPlain(paise: number): string {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(
    Math.round(paise / 100),
  );
}

/* ------------------------------------------------------------------ */

/**
 * What the run will report, listed before it runs (PRD 8, "reported metrics").
 *
 * Stating the measurements in advance is the cheapest possible guard against
 * choosing them afterwards. A report that decides which numbers to publish once
 * it has seen them is a report with a thumb on the scale, and the last row -
 * every case not recovered, with the reason - is the one that costs something
 * to promise.
 */
export function ReportContents() {
  return (
    <Section title="What the run reports" meta="fixed before it runs">
      <ul className="px-5 pb-4 pt-3">
        {MEASURES.map((measure) => (
          <li key={measure.label} className="flex gap-3 py-[7px]">
            <span
              className="mt-[7px] h-[4px] w-[4px] shrink-0 rounded-[1px] bg-waiting/70"
              aria-hidden
            />
            <span className="min-w-0">
              <span className="text-[12.5px] leading-[1.5] text-txt">{measure.label}</span>
              <span className="mt-0.5 block text-[11.5px] leading-[1.55] text-txt-faint">
                {measure.detail}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

const MEASURES = [
  {
    label: "Money recovered, and the rate",
    detail: "Overall, per case type and per root cause — by value, never by case count",
  },
  {
    label: "Uplift against the baseline",
    detail: "The headline. The same batch with the agent switched off, subtracted",
  },
  {
    label: "Diagnosis accuracy vs ground truth",
    detail: "Graded per method, with the confusions listed rather than summarised away",
  },
  {
    label: "Stopping-rule trigger counts",
    detail: "Every rule in the policy, including the ones that never fired",
  },
  {
    label: "Compliance assertions",
    detail: "Recomputed from the audit ledger, not reported by the agent",
  },
  {
    label: "Cost of the recovery",
    detail: "Inference and channels, separately, and per ₹100 that came back",
  },
  {
    label: "Every case not recovered, with the reason",
    detail: "In full, grouped by why it stopped, each one a case you can open",
  },
];

/* ------------------------------------------------------------------ */

/**
 * The configuration, restated in one line once the run is under way.
 *
 * The config panel is gone by then, and a progress bar with no statement of
 * what it is a progress bar for is a progress bar nobody can check afterwards.
 */
export function ConfigSummary({ config }: { config: SimulationConfig }) {
  const weight = CASE_TYPE_ORDER.reduce((sum, type) => sum + config.mix[type], 0);

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
      {CASE_TYPE_ORDER.map((type) => {
        const share = weight === 0 ? 0 : config.mix[type] / weight;
        return (
          <span key={type} className="policy-chip">
            {CASE_TYPE_META[type].short}
            <span className="mono text-[11px] text-txt-dim">
              {Math.round(share * config.batchSize)}
            </span>
          </span>
        );
      })}
      <span className="policy-chip">{DIFFICULTY[config.difficulty].label}</span>
      <span className="policy-chip">seed {config.seed}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */

/** A labelled proportion drawn in the product's own hand. Used by the report. */
export function StrokeRow({
  label,
  detail,
  fraction,
  color,
  seed,
  trailing,
}: {
  label: ReactNode;
  detail?: ReactNode;
  fraction: number;
  color: string;
  seed: string;
  trailing: ReactNode;
}) {
  return (
    <div className="py-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex items-baseline gap-2.5">
          <span className="chalk-hand text-[15px] uppercase tracking-[0.07em] text-txt">
            {label}
          </span>
          {detail}
        </span>
        <span className="mono shrink-0 text-[12px] text-txt-faint">{trailing}</span>
      </div>
      {/* The dashed groove underneath, so a short stroke still reads against
          the full width it is measured on. */}
      <div className="relative mt-0.5">
        <div className="absolute inset-x-0 top-0">
          <ChalkTrack height={17} />
        </div>
        <ChalkStroke fraction={fraction} color={color} seed={seed} height={17} />
      </div>
    </div>
  );
}
