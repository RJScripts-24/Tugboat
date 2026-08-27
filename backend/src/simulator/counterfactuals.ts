import { CHANNEL_COST_PAISE, voiceCostPaise } from "../channels/channel-costs";
import { istMinuteOfDay, isQuiet } from "../policy/ist-clock";
import type { PolicyChannel } from "../policy/policy-pack";
import type { GeneratedCase } from "./population";
import { complains, reactTo, retryCaptures, selfRecoversBy } from "./persona-engine";

/**
 * The two arms that were never run, and why they could not have been.
 *
 * A counterfactual is a claim about a world that did not happen. There is no
 * baseline batch to read back — switching the agent off produces no cases, no
 * actions and no ledger — so the only honest way to state what it would have
 * recovered is to ask the population directly: how many of these people were
 * going to pay anyway, and when. That number is a property of the personas, it
 * is drawn before the agent sees anything, and it is the denominator every
 * uplift figure in the report divides by.
 *
 * The naive arm is the same kind of claim about a different absence. There is
 * no naive implementation to run, because "retry and message everything
 * immediately, with no diagnosis and no bounds" is not a version of this agent
 * with a flag flipped — it is the thing a merchant does with a cron job and a
 * CSV. So it is modelled: a fixed contact schedule, the same personas, the same
 * per-contact prices, and the same complaint threshold TUGBOAT is judged by.
 *
 * What makes the comparison fair is that the *customers* are identical. The
 * same person, with the same patience and the same balance, is contacted by
 * both arms; only the judgement differs. What makes it honest is that the
 * report says which arms were executed and which were modelled, in the JSON
 * rather than in a footnote.
 */

const HOUR_MS = 60 * 60_000;

export type ArmKey = "baseline" | "naive" | "tugboat";

export type ArmResult = {
  key: ArmKey;
  recoveredPaise: number;
  recoveredCases: number;
  /** Of the money at risk, not of the case count — the funnel is by value. */
  recoveryRate: number;
  contacts: number;
  /** Simulated: a persona contacted past its own tolerance. */
  complaints: number;
  optOuts: number;
  quietHourSends: number;
  costPaise: number;
  /** Paise spent per ₹100 recovered. Null when nothing was spent. */
  costPer100Paise: number | null;
};

/** Paise spent for every ₹100 that came back. ₹100 is 10,000 paise. */
export function costPer100(costPaise: number, recoveredPaise: number): number | null {
  if (costPaise === 0) return null;
  if (recoveredPaise === 0) return Number.POSITIVE_INFINITY;
  return Math.round((costPaise / recoveredPaise) * 10_000);
}

/**
 * What a cron job does: every channel, every few hours, until it runs out of
 * schedule. Six contacts is what "no cool-down and no cap" comes to over a day
 * and a half, and the rotation is the same three channels TUGBOAT has.
 */
const NAIVE_SCHEDULE: { channel: PolicyChannel; afterHours: number }[] = [
  { channel: "RETRY", afterHours: 0 },
  { channel: "WHATSAPP", afterHours: 0.25 },
  { channel: "EMAIL", afterHours: 6 },
  { channel: "WHATSAPP", afterHours: 12 },
  { channel: "VOICE", afterHours: 20 },
  { channel: "EMAIL", afterHours: 30 },
  { channel: "WHATSAPP", afterHours: 38 },
];

/** A naive call is placed whether or not anybody picks up, and billed either way. */
const NAIVE_CALL_SECONDS = 45;

export type ArmInput = {
  cases: GeneratedCase[];
  /** How long the batch's simulated timeline runs for. */
  horizonMs: number;
  /**
   * Wall-clock instant offset zero corresponds to.
   *
   * The arms are pure functions over offsets, but "did this send fall inside
   * quiet hours" is a question about a time of day in IST. The anchor is passed
   * in rather than read from a clock so the answer is reproducible and the
   * function stays testable without a running application.
   */
  startedAtMs: number;
  /** The quiet window these arms are measured against, from the active pack. */
  quiet: { startMinutes: number; endMinutes: number };
};

/**
 * Agent off. Only the customers who were coming back on their own.
 *
 * No contacts, no cost, no complaints — and that is not a flattering
 * simplification, it is the definition. A merchant who does nothing spends
 * nothing and annoys nobody, which is exactly why "recovered more" is not on
 * its own an argument for an agent, and why the report puts the cost and the
 * complaint columns beside the money column.
 */
export function baselineArm({ cases, horizonMs }: ArmInput): ArmResult {
  const atRiskPaise = cases.reduce((sum, row) => sum + row.event.amountPaise, 0);

  const recovered = cases.filter((row) => {
    const availableHours = (horizonMs - row.arrivalOffsetMs) / HOUR_MS;
    return selfRecoversBy(row.persona, availableHours);
  });

  const recoveredPaise = recovered.reduce((sum, row) => sum + row.event.amountPaise, 0);

  return {
    key: "baseline",
    recoveredPaise,
    recoveredCases: recovered.length,
    recoveryRate: atRiskPaise === 0 ? 0 : recoveredPaise / atRiskPaise,
    contacts: 0,
    complaints: 0,
    optOuts: 0,
    quietHourSends: 0,
    costPaise: 0,
    costPer100Paise: null,
  };
}

/**
 * Everything chased on every channel, immediately, with no bounds.
 *
 * The interesting columns are not the money. This arm reaches more people than
 * doing nothing does, and it should — contacting everybody works, a bit. What
 * it also does is send into the small hours, keep messaging customers who have
 * already said STOP, and burn through the goodwill of people who were going to
 * pay anyway. Those are the columns that make the case for bounds, and they are
 * counted here rather than asserted.
 */
export function naiveArm({ cases, horizonMs, startedAtMs, quiet }: ArmInput): ArmResult {
  const atRiskPaise = cases.reduce((sum, row) => sum + row.event.amountPaise, 0);

  let contacts = 0;
  let complaints = 0;
  let optOuts = 0;
  let quietHourSends = 0;
  let costPaise = 0;
  let recoveredPaise = 0;
  let recoveredCases = 0;

  for (const row of cases) {
    const openedAtMs = row.arrivalOffsetMs;
    let contactsSent = 0;
    let optedOutAtMs: number | null = null;
    let paidAtMs: number | null = null;

    for (const step of NAIVE_SCHEDULE) {
      const atMs = openedAtMs + step.afterHours * HOUR_MS;
      if (atMs > horizonMs) break;
      // The money is already in. Even this arm has nothing left to chase.
      if (paidAtMs !== null && atMs > paidAtMs) break;

      const contact = {
        channel: step.channel,
        attempt: contactsSent + 1,
        atMs,
        openedAtMs,
        contactsSoFar: contactsSent + 1,
      };

      if (step.channel === "RETRY") {
        // A retry reaches nobody, so it costs nothing and offends nobody. The
        // one thing this arm gets right, and it gets it right by accident.
        if (paidAtMs === null && retryCaptures(row.persona, contact)) paidAtMs = atMs;
        continue;
      }

      contactsSent += 1;
      contacts += 1;
      costPaise +=
        step.channel === "VOICE" ? voiceCostPaise(NAIVE_CALL_SECONDS) : CHANNEL_COST_PAISE[step.channel];

      // No quiet-hours check exists in this arm, so a send that falls in the
      // window simply goes. This is the compliance column's whole point.
      const minute = istMinuteOfDay(new Date(startedAtMs + atMs));
      if (isQuiet(minute, quiet.startMinutes, quiet.endMinutes)) quietHourSends += 1;

      for (const reaction of reactTo(row.persona, contact)) {
        if (reaction.kind === "pay" && paidAtMs === null && reaction.atMs <= horizonMs) {
          paidAtMs = reaction.atMs;
        }
        if (reaction.kind === "reply" && row.persona.disposition === "opts-out") {
          optedOutAtMs ??= reaction.atMs;
        }
      }
    }

    if (optedOutAtMs !== null) optOuts += 1;
    // Contacting somebody after they said STOP is not a near miss, it is the
    // complaint. Everyone else complains once the schedule runs past their
    // patience, judged by the same threshold TUGBOAT is judged by.
    if (optedOutAtMs !== null || complains(row.persona, contactsSent)) complaints += 1;

    const selfRecovers = selfRecoversBy(row.persona, (horizonMs - openedAtMs) / HOUR_MS);
    if (paidAtMs !== null || selfRecovers) {
      recoveredPaise += row.event.amountPaise;
      recoveredCases += 1;
    }
  }

  return {
    key: "naive",
    recoveredPaise,
    recoveredCases,
    recoveryRate: atRiskPaise === 0 ? 0 : recoveredPaise / atRiskPaise,
    contacts,
    complaints,
    optOuts,
    quietHourSends,
    costPaise,
    costPer100Paise: costPer100(costPaise, recoveredPaise),
  };
}
