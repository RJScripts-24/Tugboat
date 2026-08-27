import type { CaseType, RootCause } from "@prisma/client";

import type { PolicyChannel } from "../policy/policy-pack";

/**
 * The four recovery playbooks (PRD 7.6), as data.
 *
 * Ported from the frontend's `LADDER` map so the plan the agent executes is the
 * plan the Case Detail page narrates. Two rules are encoded in the ordering
 * rather than written as conditions: cheapest first, because a silent retry
 * costs nothing and asks nothing of the customer, so it goes ahead of every
 * message that does; and voice never opens a ladder, because calling someone
 * who has not ignored a written nudge yet is an escalation nobody asked for.
 */

const BY_ROOT_CAUSE: Record<RootCause, PolicyChannel[]> = {
  BANK_GATEWAY_DEGRADED: ["RETRY", "RETRY", "WHATSAPP", "EMAIL"],
  INSUFFICIENT_FUNDS: ["WHATSAPP", "RETRY", "VOICE", "EMAIL"],
  CARD_EXPIRED: ["WHATSAPP", "EMAIL", "VOICE", "WHATSAPP"],
  CUSTOMER_DISTRACTED: ["EMAIL", "WHATSAPP", "VOICE", "EMAIL"],
  MANDATE_REVOKED: ["EMAIL", "WHATSAPP", "VOICE", "EMAIL"],
  UNKNOWN: ["EMAIL", "WHATSAPP", "EMAIL", "EMAIL"],
};

/** Case type overrides the root cause where the instrument dictates the sequence. */
export function ladderFor(type: CaseType, rootCause: RootCause | null): PolicyChannel[] {
  const cause = rootCause ?? "UNKNOWN";

  if (type === "MANDATE_FAILED") {
    // A revoked mandate cannot be re-presented — there is nothing left to
    // charge against, so the ladder is entirely about getting it re-authorised.
    return cause === "MANDATE_REVOKED"
      ? ["EMAIL", "WHATSAPP", "VOICE", "EMAIL"]
      : ["RETRY", "WHATSAPP", "RETRY", "VOICE"];
  }

  if (type === "INVOICE_OVERDUE") {
    return ["EMAIL", "EMAIL", "VOICE", "WHATSAPP"];
  }

  if (type === "CHECKOUT_ABANDONED" && cause !== "BANK_GATEWAY_DEGRADED") {
    return ["WHATSAPP", "EMAIL", "VOICE", "WHATSAPP"];
  }

  return BY_ROOT_CAUSE[cause];
}

/**
 * How long to wait before the first step.
 *
 * An abandoned checkout is the one case where doing nothing is the best first
 * move: a good share of people come back on their own within the hour, and a
 * nudge sent at minute two is a nudge sent to someone still typing their card
 * number.
 */
export function openingDelayMs(type: CaseType, rootCause: RootCause | null): number {
  if (type === "CHECKOUT_ABANDONED") return 45 * 60_000;
  // A gateway-wide outage is not the customer's problem and not their fix;
  // waiting for it to clear beats retrying into it.
  if (rootCause === "BANK_GATEWAY_DEGRADED") return 12 * 60_000;
  return 0;
}

export type PlanNarration = { chosen: string; because: string; rejected: { option: string; reason: string }[] };

/**
 * Why this rung and not another, in the words the timeline prints.
 *
 * The rejected alternatives are the interesting half: a plan that only records
 * what it did is a log, and a plan that records what it declined to do is a
 * decision somebody can audit.
 */
export function narrate(
  channel: PolicyChannel,
  context: {
    type: CaseType;
    rootCause: RootCause | null;
    attempt: number;
    attemptCap: number;
    degraded: boolean;
    /** Channels this customer has no contact for; the story must not invent a send on them (B-61). */
    unreachable?: readonly PolicyChannel[];
  },
): PlanNarration {
  const position = `attempt ${context.attempt} of ${context.attemptCap}`;
  const noPhone = context.unreachable?.includes("WHATSAPP") ?? false;

  switch (channel) {
    case "RETRY":
      return {
        chosen: `Silent retry against the same instrument, ${position}`,
        because: context.degraded
          ? "The gateway dipped and has recovered. The payment failed for a reason that has nothing to do with the customer, so the cheapest correct move is to try again without telling them anything happened."
          : "A retry costs nothing and asks nothing of the customer. If the money is there now, the case closes without a single message being sent.",
        rejected: [
          {
            option: "Message the customer first",
            reason: "Contacting somebody about a failure that may already have cleared is a wasted nudge and a wasted attempt",
          },
          {
            option: "Escalate to a human",
            reason: "Nothing here needs a person yet — the diagnosis is confident and the case is inside its bounds",
          },
        ],
      };

    case "WHATSAPP":
      return {
        chosen: `WhatsApp nudge with a fresh payment link, ${position}`,
        because:
          "Highest read rate and lowest cost per contact of the channels open here, and the payment link works from inside the message.",
        rejected: [
          {
            option: "Silent retry",
            reason:
              context.rootCause === "CARD_EXPIRED"
                ? "The card on file has expired — retrying it would fail identically and burn an attempt"
                : "Already tried, or the failure needs an action only the customer can take",
          },
          {
            option: "Discount to close it",
            reason: "Needs human approval, and no price-sensitivity signal exists yet",
          },
        ],
      };

    case "EMAIL":
      return {
        chosen: `Email with the payment link, ${position}`,
        because:
          context.type === "INVOICE_OVERDUE"
            ? "Receivables are settled in writing. An email is the record an accounts inbox expects and can forward internally."
            : noPhone
              ? "There is no phone number on file for this customer, so email is the first channel that can reach them."
              : "The last contact was on WhatsApp and that channel's cool-down is still running, so email is the next allowed window.",
        rejected: [
          {
            option: noPhone ? "WhatsApp" : "Second WhatsApp",
            reason: noPhone
              ? "No phone number on file — nothing to send it to"
              : "Inside the channel cool-down — the gate would block it",
          },
          {
            option: "Voice call",
            reason: "One written reminder has not been answered yet; calling now is premature",
          },
        ],
      };

    default:
      return {
        chosen: "Hinglish voice call, seeking a promise to pay",
        because:
          "Two written nudges went unanswered and the amount justifies a call. A conversation can surface a date, which no message can.",
        rejected: [
          {
            option: "Third written nudge",
            reason: "Two were ignored; a third is noise and burns the last attempt",
          },
          {
            option: "Escalate to a human now",
            reason: "No dispute or hardship signal — the agent is still inside its bounds",
          },
        ],
      };
  }
}
