import type { ReactNode } from "react";

import { ChalkNote, ChalkRule } from "@/components/dashboard/chalk";
import { CheckIcon, LockIcon, ShieldCheckSmallIcon } from "@/components/dashboard/icons";
import { MoneyValue, Section } from "@/components/dashboard/primitives";
import { formatLatency } from "@/lib/clock";
import { CASE_TYPE_META, ROOT_CAUSE_META } from "@/lib/pipeline-data";
import { formatPercent, formatRupeesCompact } from "@/lib/money";
import {
  ARM_META,
  DIFFICULTY,
  type ArmResult,
  type ComplianceAssertion,
  type ExceptionGroup,
  type Grading,
  type Headline,
  type RuleFiring,
  type SavedRun,
  type SimulationConfig,
  type TypeResult,
} from "@/lib/simulation-data";
import { ArmTable } from "./arm-table";
import { Exceptions } from "./exceptions";
import { RunHistory } from "./run-history";
import { StrokeRow } from "./run-config";

export type Report = {
  headline: Headline;
  arms: ArmResult[];
  byType: TypeResult[];
  grading: Grading;
  rules: RuleFiring[];
  compliance: { entries: number; verified: boolean; assertions: ComplianceAssertion[] };
  escalations: {
    total: number;
    pending: number;
    decided: number;
    approved: number;
    rejected: number;
    medianLatencySeconds: number;
    releasedValuePaise: number;
    recoveredAfterApprovalPaise: number;
    postApprovalRecoveryRate: number;
  };
  exceptions: ExceptionGroup[];
  runs: SavedRun[];
};

/**
 * State B of the Simulation Lab, after the run: the Evidence Report
 * (PRD 6.3, page 6).
 *
 * Ordered the way the bar in the track brief is written. Money recovered
 * against a baseline first, because that is the claim. Then whether the agent
 * understood what it was looking at, then what it cost, then the rules that
 * stopped it and the compliance assertions computed from the ledger. The
 * comparison against a policy that tries harder comes next, and the list of
 * cases it could not recover comes last and in full.
 */
/** The policy pack and build a report was produced by (`report.run` in the API's JSON). */
export type Provenance = { policyVersion: string; codeVersion: string };

export function EvidenceReport({
  config,
  report,
  executed,
  provenance,
  runs,
}: {
  config: SimulationConfig;
  report: Report;
  /** The configuration the run on screen was actually produced by. */
  executed: SimulationConfig;
  /** What produced the run on screen, read off the report rather than typed here. */
  provenance: Provenance;
  /** Run history including anything saved this session; falls back to the shipped list. */
  runs?: SavedRun[];
}) {
  const { headline, grading, escalations, compliance, rules } = report;
  const tugboat = report.arms.find((arm) => arm.key === "tugboat");
  const terminal = rules.filter((rule) => rule.terminal).reduce((sum, r) => sum + r.fired, 0);
  const fired = rules.reduce((sum, rule) => sum + rule.fired, 0);

  const drift =
    config.batchSize !== executed.batchSize ||
    config.difficulty !== executed.difficulty ||
    config.seed !== executed.seed;

  return (
    <div className="space-y-3">
      <HeadlineBand
        headline={headline}
        arms={report.arms}
        config={executed}
        provenance={provenance}
        drift={drift}
      />

      <section aria-label="Report figures" className="grid grid-cols-2 xl:grid-cols-4">
        <Figure
          label="Diagnosis accuracy"
          value={<span className="tabular">{formatPercent(grading.accuracy)}</span>}
          support={`${grading.correct} of ${grading.graded} confident calls correct · ${grading.abstained} abstained, ${grading.undiagnosed} never reached`}
        />
        <Figure
          label="Escalated to a human"
          value={<span className="tabular">{escalations.total}</span>}
          support={`${escalations.decided} decided · median ${formatLatency(
            escalations.medianLatencySeconds,
          )} · ${escalations.pending} still waiting`}
        />
        <Figure
          label="Cost per ₹100 recovered"
          value={
            <MoneyValue paise={Math.round(tugboat?.costPer100Paise ?? 0)} exact />
          }
          support={`₹${formatRupeesCompact(tugboat?.costPaise ?? 0)} in total · inference is the small column`}
        />
        <Figure
          label="Stopping rules fired"
          value={<span className="tabular">{fired}</span>}
          support={`${terminal} closed a case · the rest deferred an action and let it through later`}
        />
      </section>

      {/* `items-start` rather than the default stretch: these panels are drawn
          regions of the board, not cards in a deck, and a hairline box holding
          200px of nothing to match its neighbour reads as a rendering fault. */}
      <div className="grid grid-cols-1 items-start gap-3 xl:grid-cols-[1fr_1.05fr]">
        <ByCaseType rows={report.byType} />
        <DiagnosisPanel grading={grading} />
      </div>

      <div className="grid grid-cols-1 items-start gap-3 xl:grid-cols-[1.25fr_1fr]">
        <RulesPanel rules={rules} />
        <CompliancePanel compliance={compliance} escalations={escalations} />
      </div>

      <ArmTable arms={report.arms} />

      <Exceptions groups={report.exceptions} atRiskPaise={headline.atRiskPaise} />

      <RunHistory runs={runs ?? report.runs} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The headline                                                        */
/* ------------------------------------------------------------------ */

/**
 * The sentence the submission is graded on.
 *
 * Money recovered, the money it was recovered out of, and the difference
 * between this policy and no policy at all on the identical batch. The three
 * strokes underneath are the arms drawn to scale, so the claim can be checked
 * by eye before anybody reads a table.
 */
function HeadlineBand({
  headline,
  arms,
  config,
  provenance,
  drift,
}: {
  headline: Headline;
  arms: ArmResult[];
  config: SimulationConfig;
  provenance: Provenance;
  drift: boolean;
}) {
  return (
    <section className="headline-band px-5 py-5 sm:px-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <p className="chalk-hand text-[13px] uppercase tracking-[0.09em] text-txt-faint">
          Evidence · seed {config.seed} · policy {provenance.policyVersion} · {headline.cases} cases
        </p>
        <p className="mono text-[11.5px] text-txt-faint">
          {provenance.codeVersion} · rerun this seed and these numbers come back identical
        </p>
      </div>

      <div className="mt-4 flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div className="min-w-0">
          <p className="chalk-strong text-[clamp(32px,3.7vw,52px)] font-semibold leading-[1.02] tracking-[-0.025em] text-recovered">
            <MoneyValue paise={headline.recoveredPaise} />
          </p>
          <p className="mt-2 text-[13.5px] leading-[1.5] text-txt-dim">
            of <MoneyValue paise={headline.atRiskPaise} className="text-txt" /> at risk, recovered
            across {headline.recoveredCases} cases
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
          <Stat
            label="Recovery rate"
            value={formatPercent(headline.recoveryRate)}
            support={`baseline ${formatPercent(headline.baselineRate)} — no agent`}
          />
          <Stat
            label="Uplift vs baseline"
            value={`+${headline.upliftPoints.toFixed(1)} pts`}
            support={
              <>
                <MoneyValue paise={headline.upliftPaise} className="text-recovered" /> more than
                doing nothing
              </>
            }
            emphasis
          />
        </div>
      </div>

      {/* The three arms, drawn to scale. Same batch, same seed, different bounds. */}
      <div className="mt-4">
        <ChalkRule />
        <div className="mt-1">
          {arms.map((arm) => (
            <StrokeRow
              key={arm.key}
              label={ARM_META[arm.key].short}
              detail={
                arm.key === "tugboat" ? (
                  <ChalkNote tone="green">the arm under test</ChalkNote>
                ) : arm.key === "naive" ? (
                  <ChalkNote tone="red">
                    {arm.contacts.toLocaleString("en-IN")} contacts · {arm.quietHourSends} inside
                    quiet hours
                  </ChalkNote>
                ) : (
                  <ChalkNote>no detection, no contact</ChalkNote>
                )
              }
              fraction={arm.recoveryRate}
              color={
                arm.key === "tugboat" ? "var(--color-recovered)" : "var(--color-neutral)"
              }
              seed={`arm-${arm.key}`}
              trailing={
                <>
                  ₹{formatRupeesCompact(arm.recoveredPaise)} ·{" "}
                  <span className="text-txt-dim">{formatPercent(arm.recoveryRate)}</span>
                </>
              }
            />
          ))}
        </div>
      </div>

      {drift ? (
        <p className="mt-3 border-t border-white/[0.07] pt-3 text-[12px] leading-[1.6] text-waiting">
          The configuration has been changed since this run. What is on screen is still the batch
          that was executed — seed {config.seed}, {config.batchSize} cases,{" "}
          {DIFFICULTY[config.difficulty].label.toLowerCase()} personas. Press Run batch to put your
          configuration to the runner.
        </p>
      ) : null}
    </section>
  );
}

function Stat({
  label,
  value,
  support,
  emphasis = false,
}: {
  label: string;
  value: string;
  support: ReactNode;
  emphasis?: boolean;
}) {
  return (
    <div>
      <p className="chalk-hand text-[12.5px] uppercase tracking-[0.08em] text-txt-faint">
        {label}
      </p>
      <p
        className={`chalk-strong tabular mt-1.5 text-[clamp(22px,2vw,30px)] font-semibold leading-none tracking-[-0.02em] ${
          emphasis ? "text-recovered" : "text-txt"
        }`}
      >
        {value}
      </p>
      <p className="mt-1.5 text-[11.5px] leading-[1.45] text-txt-dim">{support}</p>
    </div>
  );
}

function Figure({
  label,
  value,
  support,
}: {
  label: string;
  value: ReactNode;
  support: ReactNode;
}) {
  return (
    <div className="px-5 py-3.5">
      <p className="chalk-hand text-[13px] uppercase tracking-[0.08em] text-txt-faint">{label}</p>
      <p className="chalk-strong mt-2 text-[clamp(21px,1.7vw,26px)] font-semibold leading-none tracking-[-0.015em] text-txt">
        {value}
      </p>
      <ChalkRule className="mt-2 w-[58%]" />
      <p className="mt-2 text-[11.5px] leading-[1.45] text-txt-dim">{support}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Recovery by case type                                               */
/* ------------------------------------------------------------------ */

/**
 * Four playbooks, four recovery rates.
 *
 * By value rather than by case count, for the reason the Control Tower's funnel
 * is: fifty ₹200 checkouts recovering matters less than three ₹40,000 invoices
 * not, and a count-based bar hides exactly that.
 */
function ByCaseType({ rows }: { rows: TypeResult[] }) {
  const total = rows.reduce((sum, row) => sum + row.atRiskPaise, 0);
  const ranked = [...rows].sort((a, b) => b.rate - a.rate);
  const best = ranked[0];
  const worst = ranked[ranked.length - 1];
  const heaviest = [...rows].sort((a, b) => b.atRiskPaise - a.atRiskPaise)[0];

  return (
    <Section title="Recovery by case type" meta={`₹${formatRupeesCompact(total)} at risk`}>
      <div className="px-5 pb-4 pt-1">
        {rows.map((row) => (
          <StrokeRow
            key={row.type}
            label={CASE_TYPE_META[row.type].label}
            detail={
              <ChalkNote>
                {row.recoveredCases} of {row.cases} cases
              </ChalkNote>
            }
            fraction={row.rate}
            color="var(--color-recovered)"
            seed={row.type}
            trailing={
              <>
                ₹{formatRupeesCompact(row.recoveredPaise)} ·{" "}
                <span className="text-txt-dim">{formatPercent(row.rate)}</span>
              </>
            }
          />
        ))}
      </div>

      <div className="border-t border-white/[0.06] px-5 py-3">
        <p className="text-[12px] leading-[1.6] text-txt-dim">
          {CASE_TYPE_META[best.type].label} recovers best at {formatPercent(best.rate)} and{" "}
          {CASE_TYPE_META[worst.type].label.toLowerCase()} worst at {formatPercent(worst.rate)} —
          and {CASE_TYPE_META[heaviest.type].label.toLowerCase()} carries the most money at risk
          (₹{formatRupeesCompact(heaviest.atRiskPaise)}). The biggest single lever on the headline
          is therefore the playbook that is currently doing least well, which is where the next
          week of work goes.
        </p>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Diagnosis vs ground truth                                           */
/* ------------------------------------------------------------------ */

/**
 * The grade, split by how the diagnosis was reached.
 *
 * This is the panel that argues for the architecture. The rules table answers
 * most of the batch, for nothing, and is right almost every time; the model is
 * only asked the questions the table has no row for, and is measurably worse at
 * them. Both facts are on the page, because publishing only the blended figure
 * would be hiding the one that decides where to put the next week of work.
 */
function DiagnosisPanel({ grading }: { grading: Grading }) {
  return (
    <Section
      title="Diagnosis vs ground truth"
      meta={`${grading.correct}/${grading.graded} correct`}
    >
      <div className="px-5 pb-3 pt-2">
        {grading.byMethod.map((row) => (
          <StrokeRow
            key={row.method}
            label={row.method === "RULES" ? "Rules table" : "Model"}
            detail={
              <ChalkNote tone={row.method === "RULES" ? "dim" : "blue"}>
                {row.method === "RULES"
                  ? "no model call · deterministic"
                  : "only the codes the table cannot map"}
              </ChalkNote>
            }
            fraction={row.accuracy}
            color={
              row.method === "RULES" ? "var(--color-neutral)" : "var(--color-diagnosis)"
            }
            seed={`method-${row.method}`}
            trailing={
              <>
                {row.correct}/{row.graded} ·{" "}
                <span className="text-txt-dim">{formatPercent(row.accuracy)}</span>
              </>
            }
          />
        ))}
      </div>

      <ChalkRule />

      <div className="scroll-thin overflow-x-auto">
        <table className="optable">
          <thead>
            <tr>
              <th>What it really was</th>
              <th>What Boa called it</th>
              <th className="num">Cases</th>
            </tr>
          </thead>
          <tbody>
            {grading.confusions.map((row) => (
              <tr key={`${row.truth}-${row.called}`}>
                <td className="text-txt-dim">{ROOT_CAUSE_META[row.truth].label}</td>
                <td className="text-halted">{ROOT_CAUSE_META[row.called].label}</td>
                <td className="num mono text-txt-dim">{row.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="border-t border-white/[0.06] px-5 py-3">
        <p className="text-[12px] leading-[1.6] text-txt-dim">
          {grading.abstained} more cases were diagnosed under the 0.60 confidence floor and are not
          graded here — the agent declined to name a cause and escalated instead, which is the
          behaviour the floor exists to produce.
        </p>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Stopping rules                                                      */
/* ------------------------------------------------------------------ */

function RulesPanel({ rules }: { rules: RuleFiring[] }) {
  const terminal = rules.filter((rule) => rule.terminal).reduce((sum, r) => sum + r.fired, 0);

  return (
    <Section title="Stopping rules" meta={`${terminal} cases closed by a rule`}>
      <div className="scroll-thin overflow-x-auto">
        <table className="optable">
          <thead>
            <tr>
              <th>Rule</th>
              <th>What it did</th>
              <th className="num">Fired</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((rule) => (
              <tr key={rule.key} className={rule.fired === 0 ? "rule-idle" : undefined}>
                <td>
                  <span className="flex items-center gap-2">
                    <span className={rule.terminal ? "text-txt" : "text-txt-dim"}>
                      {rule.rule}
                    </span>
                    {rule.locked ? (
                      <LockIcon
                        className="h-[11px] w-[11px] shrink-0 text-txt-faint"
                        aria-label="cannot be switched off"
                      />
                    ) : null}
                  </span>
                </td>
                {/* Wrapping, not truncated: "HALTED on every channel, permanen…"
                    is the half of the row that says what the number means. */}
                <td className="max-w-[340px] whitespace-normal text-txt-faint">{rule.effect}</td>
                <td
                  className={`num mono ${
                    rule.fired === 0
                      ? "text-txt-faint"
                      : rule.terminal
                        ? "text-halted"
                        : "text-waiting"
                  }`}
                >
                  {rule.fired}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="border-t border-white/[0.06] px-5 py-3">
        <p className="text-[12px] leading-[1.6] text-txt-dim">
          Two rows fired zero times and are still here. A guardrail list that only shows the rules
          that triggered is a list nobody can audit — and the counts on the four terminal rows are
          read back off the cases they closed, not kept beside them.
        </p>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Compliance                                                          */
/* ------------------------------------------------------------------ */

/**
 * The compliance assertions, and the sentence that gives them their weight:
 * they are computed from the append-only ledger rather than from the agent's
 * own account of what it did (PRD 8). An agent grading its own conduct is
 * exactly the evidence a payments panel should refuse.
 */
function CompliancePanel({
  compliance,
  escalations,
}: {
  compliance: { entries: number; verified: boolean; assertions: ComplianceAssertion[] };
  escalations: Report["escalations"];
}) {
  return (
    <Section
      title="Compliance"
      action={
        <span className="flex shrink-0 items-center gap-2 text-[11.5px] text-recovered">
          <ShieldCheckSmallIcon className="h-[13px] w-[13px]" />
          chain verified · {compliance.entries.toLocaleString("en-IN")} entries
        </span>
      }
    >
      <ul className="px-5 pb-3 pt-3">
        {compliance.assertions.map((assertion) => (
          <li key={assertion.claim} className="flex gap-3 py-2">
            <span className="mt-[2px] shrink-0">
              <CheckIcon
                className={`h-[13px] w-[13px] ${
                  assertion.held ? "text-recovered" : "text-halted"
                }`}
              />
            </span>
            <span className="min-w-0">
              <span className="block text-[12.5px] leading-[1.5] text-txt">{assertion.claim}</span>
              <span className="mt-0.5 block text-[11.5px] leading-[1.55] text-txt-faint">
                {assertion.detail}
              </span>
            </span>
          </li>
        ))}
      </ul>

      <ChalkRule />

      <div className="px-5 py-3.5">
        <p className="chalk-hand text-[13px] uppercase tracking-[0.08em] text-txt-faint">
          Human in the loop
        </p>
        <p className="mt-2 text-[12.5px] leading-[1.65] text-txt-dim">
          {escalations.total} cases were handed to a person rather than acted on.{" "}
          {escalations.approved} were released and {escalations.rejected} refused, at a median
          response of {formatLatency(escalations.medianLatencySeconds)}. Of the{" "}
          <MoneyValue paise={escalations.releasedValuePaise} className="text-txt" /> a yes let back
          into the pipeline,{" "}
          <MoneyValue
            paise={escalations.recoveredAfterApprovalPaise}
            className="text-recovered"
          />{" "}
          came back — {formatPercent(escalations.postApprovalRecoveryRate)}.
        </p>
        <p className="mt-2.5 text-[11.5px] leading-[1.6] text-txt-faint">
          Every assertion above is recomputed from the case ledger — {""}
          {compliance.entries.toLocaleString("en-IN")} ledger entries — not reported by the agent.
          That is the same ledger, and the same count, the Audit Explorer browses; the chain is what
          makes re-verifying it by hand possible.
        </p>
      </div>
    </Section>
  );
}
