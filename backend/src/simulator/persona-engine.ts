import type { VoiceCounterpart } from "../channels/channel-adapter.interface";
import type { PolicyChannel } from "../policy/policy-pack";
import type { Persona } from "./persona";
import { SeededRng } from "./seeded-rng";

/**
 * What the customer does about a contact.
 *
 * Every draw here is keyed by the persona's own seed plus the channel and the
 * attempt, never by a database id. That is the difference between a batch that
 * reproduces and one that only looks like it does: case ids are assigned by an
 * autoincrement that has no memory of the previous run, so anything seeded from
 * one produces a different report on the second run of the same seed.
 *
 * The engine is deliberately dumb about policy. It does not know what a
 * cool-down is, it is never asked whether an action was allowed, and it cannot
 * see the agent's diagnosis. It answers one question — a message arrived at
 * this hour on this channel, what does this person do — and everything that
 * makes the batch interesting comes out of that plus the bounds the agent is
 * working under.
 */

const HOUR_MS = 60 * 60_000;

export type Contact = {
  channel: PolicyChannel;
  attempt: number;
  /** Simulated instant the contact landed. */
  atMs: number;
  /** Simulated instant the case was opened, which is when the funds clock starts. */
  openedAtMs: number;
  /** Contacts this customer has now received on this case, including this one. */
  contactsSoFar: number;
  /** Set when the message carried an approved concession. */
  concessionPaise?: number;
};

export type Reaction =
  | { kind: "reply"; channel: PolicyChannel; text: string; atMs: number; note: string }
  | { kind: "pay"; atMs: number; note: string };

/** English and Hinglish pairs, so the language preference is exercised end to end. */
const REPLIES = {
  optOut: {
    "en-IN": ["STOP", "STOP. Do not message me again.", "UNSUBSCRIBE"],
    "hi-IN": ["BAND KARO", "मत भेजो, STOP", "बंद करो ये messages"],
  },
  hostile: {
    "en-IN": [
      "This is harassment. I have already told you I am not paying this.",
      "Stop chasing me over this, it is not my problem that your payment failed.",
      "Absolutely fed up of these messages. Escalating this to my bank.",
    ],
    "hi-IN": [
      "Bahut zyada ho raha hai ye. Baar baar message mat karo.",
      "Mujhe pareshaan mat karo, main nahi bhar raha ye amount.",
    ],
  },
  hardship: {
    "en-IN": [
      "Things are very tight this month after a medical bill. I cannot afford this right now.",
      "I lost my job last month, there is no money. Please give me some time.",
      "I am disputing this charge, it is not mine.",
    ],
    "hi-IN": [
      "Is mahine paisa nahi hai, medical ka kharcha aa gaya. Thodi dikkat hai.",
      "Majboori hai bhai, abhi paise nahi hain.",
    ],
  },
  price: {
    "en-IN": [
      "Can you do something on the price? It is a bit expensive for me right now.",
      "If you give me a discount I will pay today.",
      "Too costly. Any offer available?",
    ],
    "hi-IN": [
      "Thoda kam kar sakte ho? Abhi mehenga pad raha hai.",
      "Koi discount mile to aaj hi pay kar dunga.",
    ],
  },
  positive: {
    "en-IN": [
      "Sorry, I missed this. Paying now.",
      "Thanks for the reminder, will complete the payment shortly.",
      "Got it, the card had an issue. Using the link now.",
    ],
    "hi-IN": [
      "Sorry, dhyaan nahi gaya. Abhi kar deta hoon.",
      "Thik hai, link se pay kar deta hoon.",
    ],
  },
  promising: {
    "en-IN": [
      "I will clear this by Friday, salary comes in then.",
      "Give me till the weekend and I will settle it.",
    ],
    "hi-IN": ["Friday tak kar dunga, salary aa jayegi.", "Weekend tak settle kar dunga."],
  },
} as const;

function line(rng: SeededRng, bucket: keyof typeof REPLIES, languagePref: string): string {
  const lang = languagePref.startsWith("hi") ? "hi-IN" : "en-IN";
  return rng.pick(REPLIES[bucket][lang]);
}

/**
 * Does a silent re-presentation capture?
 *
 * Answered from the *true* cause and the funds window, never from what the
 * agent believes: an expired card declines identically however confidently it
 * was diagnosed, and a balance that arrives on payday arrives whether or not
 * anybody worked out that was the problem. This is the one place a wrong
 * diagnosis costs real money in the batch, which is what makes the accuracy
 * figure worth reporting.
 */
export function retryCaptures(persona: Persona, contact: Contact): boolean {
  if (!Number.isFinite(persona.fundsAvailableAfterHours)) return false;

  const elapsedHours = (contact.atMs - contact.openedAtMs) / HOUR_MS;
  if (elapsedHours < persona.fundsAvailableAfterHours) return false;

  // Funds being there is necessary, not sufficient: an auto-debit can still be
  // declined for reasons nobody models, and a batch in which every well-timed
  // retry succeeds would overstate the cheapest channel.
  const rng = new SeededRng(`${persona.seed}/retry/${contact.attempt}`);
  return rng.bool(0.86);
}

/** How a call goes. Never a coin flip on the case id — the persona decides. */
export function voiceCounterpart(persona: Persona, contact: Contact): VoiceCounterpart {
  const rng = new SeededRng(`${persona.seed}/voice/${contact.attempt}`);

  if (!rng.bool(persona.responsiveness.VOICE)) return "no-answer";

  switch (persona.disposition) {
    case "promises":
    case "pays-on-nudge":
      return "promise";
    case "hardship":
      return "decline";
    case "haggles":
      // A haggler on the phone still commits, then argues about the number in
      // writing. The concession ask arrives as a reply, not as a refusal.
      return rng.bool(0.55) ? "promise" : "decline";
    case "hostile":
      return "decline";
    default:
      return "no-answer";
  }
}

/**
 * Everything this customer does about one contact.
 *
 * Returns a list because a single message can produce both a reply and, later,
 * a payment — and the gap between them is the thing a recovery agent is
 * actually managing.
 */
export function reactTo(persona: Persona, contact: Contact): Reaction[] {
  // A silent retry contacts nobody, so there is nobody to react. Whether it
  // captured was decided by `retryCaptures` before the send.
  if (contact.channel === "RETRY") return [];

  const rng = new SeededRng(`${persona.seed}/react/${contact.channel}/${contact.attempt}`);
  const replyAt = contact.atMs + persona.replyDelayHours * HOUR_MS;

  const reply = (bucket: keyof typeof REPLIES, note: string): Reaction => ({
    kind: "reply",
    channel: contact.channel,
    text: line(rng, bucket, persona.languagePref),
    atMs: replyAt,
    note,
  });

  // Paying takes as long as the money takes. For a persona whose balance is the
  // problem, willingness arrives long before the funds do.
  const payAt = Math.max(
    replyAt + rng.float(0.2, 6) * HOUR_MS,
    Number.isFinite(persona.fundsAvailableAfterHours)
      ? contact.openedAtMs + persona.fundsAvailableAfterHours * HOUR_MS
      : replyAt,
  );

  const pay = (note: string): Reaction => ({ kind: "pay", atMs: payAt, note });

  /**
   * Past this person's tolerance, being contacted stops helping.
   *
   * A model without this says more messages are always better, which implies
   * no merchant should ever have a bound — a conclusion obviously false in the
   * world and one a policy simulator must not be capable of producing. Message
   * fatigue is the reason cool-downs and caps exist, so a harness meant to
   * evaluate them has to contain it.
   *
   * Two effects, both real. Somebody chased past their patience is far less
   * likely to act on the next message, and materially more likely to end the
   * relationship outright — which costs the sender not just this payment but
   * every future one.
   */
  const fatigued = contact.contactsSoFar > persona.complaintThreshold;

  if (fatigued && persona.disposition !== "opts-out") {
    const rng2 = new SeededRng(`${persona.seed}/fatigue/${contact.attempt}`);

    if (rng2.bool(0.28)) {
      return [reply("optOut", "Opted out after being contacted past their tolerance")];
    }

    return rng2.bool(persona.silentConversion * 0.2)
      ? [pay("Paid despite being over-contacted")]
      : [];
  }

  // An opt-out is not conditional on mood or channel: the first message that
  // reaches this person is answered with STOP, and that is the whole story.
  if (persona.disposition === "opts-out") {
    return rng.bool(Math.max(0.55, persona.responsiveness[contact.channel]))
      ? [reply("optOut", "Opt-out keyword — every channel closes permanently")]
      : [];
  }

  // Only the silent tail is truly inert. Somebody who ignores messages has not
  // refused to pay — they have refused to *reply*, which are different things
  // and were conflated here at first: the early return sat above the silent
  // conversion branch, so the one disposition the trait was written for was the
  // one disposition that could never use it, and 46% of a realistic population
  // was structurally incapable of paying (B-32).
  if (persona.disposition === "silent") return [];

  // Below the persona's reach on this channel, they do not answer. That is not
  // the same as doing nothing: most recoveries in the real world are somebody
  // clicking the link and paying without a word, and a model in which only the
  // people who write back can pay would cap recovery at the response rate.
  if (!rng.bool(persona.responsiveness[contact.channel])) {
    return rng.bool(persona.silentConversion) ? [pay("Paid the link without replying")] : [];
  }

  switch (persona.disposition) {
    case "hostile":
      // Patience runs out; before it does, being chased is merely ignored.
      return contact.contactsSoFar >= persona.patience
        ? [reply("hostile", "Hostile reply — the sentiment halt should stop the case here")]
        : [];

    case "hardship":
      return [reply("hardship", "Hardship language — escalates rather than halting")];

    case "haggles":
      // Once a human has approved a concession, the objection is answered and
      // the money follows. Until then the reply is the ask.
      return (contact.concessionPaise ?? 0) > 0
        ? [reply("positive", "Concession accepted"), pay("Paid after an approved concession")]
        : [reply("price", "Price objection — the only signal that lets a discount be proposed")];

    case "promises":
      return [reply("promising", "Commits to a date"), pay("Honoured the commitment")];

    default:
      return [reply("positive", "Pays after the nudge"), pay("Paid from the link in the message")];
  }
}

/**
 * Whether being contacted this many times has crossed the line for this person.
 *
 * Used only by the naive counterfactual, which is the arm that has no bounds to
 * cross it with. TUGBOAT's own complaint count comes from the same function
 * over the contacts it actually sent, so the two arms are judged by one
 * standard rather than each by its own.
 */
export function complains(persona: Persona, contactsSent: number): boolean {
  return contactsSent > persona.complaintThreshold;
}

/**
 * Whether this person pays with nobody chasing them at all.
 *
 * The baseline arm, one customer at a time. It reads only the persona, because
 * a counterfactual about an agent that was switched off cannot read anything
 * the agent did.
 */
export function selfRecoversBy(persona: Persona, hoursFromOpening: number): boolean {
  return persona.wouldSelfRecover && hoursFromOpening >= persona.selfRecoverAfterHours;
}

/**
 * The same fact as an instant, for the arm that actually runs.
 *
 * The baseline is built from `wouldSelfRecover`; the executed batch has to
 * honour the same trait or it is being measured against a customer it was
 * never allowed to have. Until it did, a person nobody reached paid in the arm
 * that never ran and not in the one that did (B-46, D-121). Null when the
 * payment would land past the horizon, which is exactly when `selfRecoversBy`
 * says no.
 */
export function unpromptedPaymentAt(
  persona: Persona,
  openedAtMs: number,
  horizonMs: number,
): number | null {
  if (!persona.wouldSelfRecover) return null;

  const atMs = openedAtMs + persona.selfRecoverAfterHours * HOUR_MS;
  return atMs <= horizonMs ? atMs : null;
}
