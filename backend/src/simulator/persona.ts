import type { CaseType, CustomerSegment, RootCause } from "@prisma/client";

import type { PolicyChannel } from "../policy/policy-pack";
import { DIFFICULTY, type DifficultyKey } from "./difficulty";
import { SeededRng } from "./seeded-rng";

/**
 * The person on the other end of the case.
 *
 * A persona is the simulator's whole model of a customer, and it is deliberately
 * NOT a bag of independent coin flips. Independent flips produce a population
 * whose members contradict themselves — somebody who opts out on Monday and
 * pays cheerfully on Tuesday — and a batch of those grades an agent on noise.
 * Each persona is drawn one disposition first, and every later trait is
 * conditioned on it, so a hostile customer stays hostile and a haggler haggles
 * before they pay.
 *
 * Nothing in `agent-core`, `policy`, `channels` or `cases` may import this file.
 * The agent is being measured; letting it read the answer key would make every
 * accuracy figure in the evidence report worthless. `architecture.spec.ts`
 * enforces that, and `sim_ground_truth` holds the copy that only `metrics`
 * joins, and only at grading time (ADR-10).
 */

/**
 * How this customer behaves when contacted.
 *
 * The order runs from most cooperative to least, which is also the order the
 * report's exception groups read in.
 */
export const DISPOSITIONS = [
  /** Answers, and the first message that reaches them is enough. */
  "pays-on-nudge",
  /** Answers, commits to a date, and honours it — the promise path. */
  "promises",
  /** Answers, objects to the price, and pays only if a concession is offered. */
  "haggles",
  /** Answers to say money is genuinely tight. Escalates rather than halting. */
  "hardship",
  /** Answers angrily. The sentiment halt is supposed to stop here. */
  "hostile",
  /** Answers once, with STOP. Every channel closes, permanently. */
  "opts-out",
  /** Never answers, but the money may still arrive if the instrument recovers. */
  "ignores",
  /** Never answers and never pays. The honest tail of any real batch. */
  "silent",
] as const;

export type Disposition = (typeof DISPOSITIONS)[number];

export type Persona = {
  /** Position in the generated population. Every outcome is seeded from this. */
  index: number;
  /** The stream every decision about this person is drawn from. */
  seed: string;
  disposition: Disposition;

  name: string;
  email: string;
  phone: string;
  languagePref: string;
  segment: CustomerSegment;

  /** Probability of answering a contact on each channel, per attempt. */
  responsiveness: Record<PolicyChannel, number>;
  /** Contacts this person absorbs before an answer turns sour. */
  patience: number;
  /**
   * Chance per contact of paying the link without answering the message.
   *
   * The single most important trait in the model, and the one most easily left
   * out. Recovery is not a conversation: most people who act on a payment
   * reminder never reply to it, they click the link. A simulator in which only
   * the customers who write back can pay measures a chatbot, and would report a
   * recovery rate capped at the response rate — which is both wrong and
   * flattering in the wrong direction, since it makes the agent look worse
   * while making its conversational features look load-bearing.
   */
  silentConversion: number;
  /** How long after a contact lands before they act on it. */
  replyDelayHours: number;

  /**
   * When money is actually available, in hours from the case opening.
   *
   * `Infinity` means never — a revoked mandate or an expired card is not a
   * timing problem, and no amount of retrying makes one work.
   */
  fundsAvailableAfterHours: number;

  /** The truth the agent must never see. */
  trueRootCause: RootCause;
  /** Would have paid with no contact at all — this is the baseline arm. */
  wouldSelfRecover: boolean;
  selfRecoverAfterHours: number;

  /** Contacts beyond which a naive strategy provokes a complaint. */
  complaintThreshold: number;

  /** One line for the ground-truth table, so a grader can read the case. */
  summary: string;
};

const FIRST_NAMES = [
  "Aarav", "Isha", "Rohan", "Meera", "Kabir", "Ananya", "Devansh", "Prisha",
  "Vikram", "Nandini", "Arjun", "Tara", "Ishaan", "Kavya", "Rehan", "Sana",
  "Yash", "Diya", "Aditya", "Riya", "Nikhil", "Aisha", "Siddharth", "Pooja",
  "Manav", "Lata", "Zoya", "Harsh", "Neel", "Anika", "Farhan", "Gauri",
  "Imran", "Jaya", "Karthik", "Leela", "Mohit", "Nisha", "Omkar", "Payal",
];

const LAST_NAMES = [
  "Sharma", "Iyer", "Nair", "Reddy", "Banerjee", "Kulkarni", "Chatterjee", "Menon",
  "Deshpande", "Gowda", "Bhatt", "Sethi", "Chauhan", "Pillai", "Rao", "Joshi",
  "Verma", "Mehta", "Kaur", "Dutta", "Ghosh", "Naidu", "Patil", "Saxena",
  "Trivedi", "Bose", "Chopra", "Fernandes", "Hegde", "Jain", "Khanna", "Lal",
  "Mishra", "Prabhu", "Shetty",
];

const BRAND_HEADS = [
  "Saffron", "Indus", "Peacock", "Banyan", "Coral", "Monsoon", "Kalinga", "Deccan",
  "Nilgiri", "Konkan", "Sunder", "Chinar", "Marigold", "Ashoka", "Kaveri", "Neelam",
];

const BRAND_TAILS = [
  "Labs", "Foods", "Retail", "Dairy", "Interiors", "Textiles", "Fitness",
  "Studio", "Group", "Traders", "Exports", "Logistics", "Kitchens", "Motors", "Prints",
];

/**
 * Channel reach, relative to the persona's own base rate.
 *
 * WhatsApp is read; email is filed; a call is either answered or it is not, and
 * when it is answered it is by far the likeliest to produce an actual
 * commitment. These are the ratios a payments team would recognise, and they
 * are the reason the playbook ladders are ordered the way they are.
 */
const CHANNEL_REACH: Record<PolicyChannel, number> = {
  WHATSAPP: 1.0,
  EMAIL: 0.55,
  VOICE: 0.78,
  // A silent retry reaches nobody, so nobody answers it. Kept in the record so
  // every channel has a stated value rather than an implied one.
  RETRY: 0,
};

const RUPEE = 100;

/**
 * The disposition mix for a preset.
 *
 * `responseRate` is spent across the five dispositions that answer, in
 * proportions that hold across presets: even in a hostile population, most of
 * the people who bother to reply are replying because they intend to pay. What
 * difficulty changes is how many reply at all.
 */
function dispositionWeights(difficulty: DifficultyKey): (readonly [Disposition, number])[] {
  const preset = DIFFICULTY[difficulty];
  const answering = preset.responseRate;
  const ignores = Math.max(0, 1 - answering - preset.optOutRate - preset.silentTail);

  const hostileShare = difficulty === "hostile" ? 0.22 : difficulty === "realistic" ? 0.13 : 0.07;
  const hardshipShare = difficulty === "hostile" ? 0.14 : 0.1;
  const haggleShare = 0.14;
  const promiseShare = 0.24;
  const nudgeShare = Math.max(0.05, 1 - hostileShare - hardshipShare - haggleShare - promiseShare);

  return [
    ["pays-on-nudge", answering * nudgeShare],
    ["promises", answering * promiseShare],
    ["haggles", answering * haggleShare],
    ["hardship", answering * hardshipShare],
    ["hostile", answering * hostileShare],
    ["opts-out", preset.optOutRate],
    ["ignores", ignores],
    ["silent", preset.silentTail],
  ] as const;
}

/**
 * How often somebody just pays, without a word.
 *
 * Zero for the customers for whom paying is not the issue: nobody who is about
 * to send STOP quietly settles first, and a hostile reply is not followed by a
 * payment. Everyone else has some chance per contact, highest for the people
 * who were going to pay anyway and merely needed reminding.
 */
function silentConversionRate(
  rng: SeededRng,
  disposition: Disposition,
  cause: RootCause,
): number {
  if (disposition === "opts-out" || disposition === "hostile" || disposition === "silent") return 0;
  // A revoked mandate needs a new authorisation, not a click; the ladder for it
  // is about getting that, and a quiet payment is not one of the outcomes.
  if (cause === "MANDATE_REVOKED") return rng.float(0.03, 0.08);
  if (disposition === "hardship") return rng.float(0.02, 0.07);
  if (disposition === "haggles") return rng.float(0.04, 0.1);

  // Per *contact*, not per case: a customer who receives three messages over a
  // week has three chances to act on one. Calibrated so a realistic batch lands
  // in the band the stage is judged on — roughly one message in eight is acted
  // on by somebody who can pay, which compounds to about a third of them over a
  // full ladder and is the shape merchant link click-through actually has.
  return rng.normal(0.12, 0.05, 0.03, 0.28);
}

/** Hours until the money is there, by what actually went wrong. */
function fundsWindow(rng: SeededRng, cause: RootCause, disposition: Disposition): number {
  // Nothing the agent does to the instrument will work: these need the customer
  // to act, which is exactly why their playbooks open with a message.
  if (cause === "CARD_EXPIRED" || cause === "MANDATE_REVOKED") return Infinity;
  if (disposition === "silent") return Infinity;

  // An outage clears on its own, usually within the hour.
  if (cause === "BANK_GATEWAY_DEGRADED") return rng.normal(1.4, 1.1, 0.2, 8);

  // Salaries land at month end; the tail is people whose balance is not a
  // timing problem at all.
  if (cause === "INSUFFICIENT_FUNDS") {
    return rng.bool(0.62) ? rng.normal(38, 22, 2, 96) : Infinity;
  }

  return rng.normal(12, 10, 0.5, 72);
}

export type PersonaDraw = {
  index: number;
  runSeed: string;
  difficulty: DifficultyKey;
  caseType: CaseType;
  trueRootCause: RootCause;
  amountPaise: number;
};

/**
 * One persona, drawn from its own stream.
 *
 * The stream is keyed by run seed and index rather than shared with the rest of
 * the batch, so adding a draw to the population generator does not reshuffle
 * every customer after it — the report has to survive the code being edited.
 */
export function buildPersona(draw: PersonaDraw): Persona {
  const seed = `${draw.runSeed}/persona/${draw.index}`;
  const rng = new SeededRng(seed);
  const preset = DIFFICULTY[draw.difficulty];

  const disposition = rng.weighted(dispositionWeights(draw.difficulty));

  // A business pays out of a process, not a mood: B2B customers answer more
  // slowly, on email, and are far likelier to be the high-value cases the
  // escalation gate is watching for.
  const business =
    draw.caseType === "INVOICE_OVERDUE"
      ? rng.bool(0.82)
      : draw.amountPaise >= 25_000 * RUPEE
        ? rng.bool(0.45)
        : rng.bool(0.08);

  const name = business
    ? `${rng.pick(BRAND_HEADS)} ${rng.pick(BRAND_TAILS)}`
    : `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`;

  const base =
    disposition === "silent" || disposition === "ignores" ? 0 : rng.normal(0.62, 0.16, 0.18, 0.95);

  const responsiveness: Record<PolicyChannel, number> = {
    WHATSAPP: base * CHANNEL_REACH.WHATSAPP * (business ? 0.7 : 1),
    EMAIL: base * CHANNEL_REACH.EMAIL * (business ? 1.6 : 1),
    VOICE: base * CHANNEL_REACH.VOICE * (business ? 0.8 : 1),
    RETRY: 0,
  };

  // Conditional on being able to self-recover at all, and divided by exactly
  // that share so the preset's headline rate is what comes out the other end.
  // A flat draw here would overshoot on `easy`, where almost everybody is
  // eligible, and undershoot on `hostile`, where a third of the population can
  // never pay — the preset would then be describing a batch nobody produced.
  const eligible = Math.max(0.1, 1 - preset.optOutRate - preset.silentTail);
  const wouldSelfRecover =
    disposition !== "silent" &&
    disposition !== "opts-out" &&
    draw.trueRootCause !== "MANDATE_REVOKED" &&
    rng.bool(Math.min(1, preset.selfRecoveryRate / eligible));

  return {
    index: draw.index,
    seed,
    disposition,
    name,
    // Contacts are unroutable by construction: `.invalid` is the reserved TLD
    // that can never resolve, so a channel adapter switched to a real provider
    // by mistake cannot reach a stranger (RFC 2606).
    email: `${slug(name)}.${draw.index}@sim.tugboat.invalid`,
    phone: `+9198${String(70_000_000 + draw.index * 7919).slice(0, 8)}`,
    languagePref: rng.bool(business ? 0.12 : 0.42) ? "hi-IN" : "en-IN",
    segment: (business ? "B2B" : "B2C") as CustomerSegment,
    responsiveness,
    patience: Math.round(rng.normal(disposition === "hostile" ? 1.6 : 3.2, 1.1, 1, 6)),
    silentConversion: silentConversionRate(rng, disposition, draw.trueRootCause),
    replyDelayHours: rng.normal(business ? 9 : 3.5, business ? 6 : 3, 0.25, 40),
    fundsAvailableAfterHours: fundsWindow(rng, draw.trueRootCause, disposition),
    trueRootCause: draw.trueRootCause,
    wouldSelfRecover,
    selfRecoverAfterHours: rng.normal(34, 20, 3, 120),
    complaintThreshold: Math.round(rng.normal(disposition === "hostile" ? 2 : 4, 1.4, 1, 8)),
    summary: summarise(disposition, draw.trueRootCause, wouldSelfRecover),
  };
}

function summarise(disposition: Disposition, cause: RootCause, wouldSelfRecover: boolean): string {
  const tail = wouldSelfRecover ? " · would have paid unprompted" : "";

  switch (disposition) {
    case "pays-on-nudge":
      return `Pays once a message reaches them · true cause ${cause}${tail}`;
    case "promises":
      return `Commits to a date on a call and honours it · true cause ${cause}${tail}`;
    case "haggles":
      return `Objects to the price before paying · true cause ${cause}${tail}`;
    case "hardship":
      return `Declares financial hardship · true cause ${cause}${tail}`;
    case "hostile":
      return `Replies angrily to being chased · true cause ${cause}${tail}`;
    case "opts-out":
      return `Sends STOP on first contact · true cause ${cause}`;
    case "ignores":
      return `Never replies; may still pay if the instrument recovers · true cause ${cause}${tail}`;
    default:
      return `Never replies and never pays · true cause ${cause}`;
  }
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "customer";
}
