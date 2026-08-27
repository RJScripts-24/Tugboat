import { Injectable } from "@nestjs/common";
import type { Case, Customer } from "@prisma/client";
import { z } from "zod";

import type { CopyContext } from "../channels/message-copy";
import { POLICY_CHANNELS, type PolicyChannel } from "../policy/policy-pack";
import { ladderFor, narrate, openingDelayMs, type PlanNarration } from "./playbooks";

/**
 * The plan, validated whether it came from a table or a model.
 *
 * Today every plan comes from the ladder, which is the point: the playbooks are
 * a decision a payments team already knows how to argue about, and running them
 * through a model would add cost, latency and nondeterminism to reproduce an
 * answer that is already correct (ADR-5, the same argument as the rules-first
 * Diagnoser). The schema exists anyway, because the moment a plan does come
 * from a model it must clear the same bar — and a schema added later is a
 * schema added after the first bad plan.
 */
export const planProposalSchema = z
  .object({
    channel: z.enum(POLICY_CHANNELS),
    attempt: z.number().int().min(1),
    chosen: z.string().min(1),
    because: z.string().min(1),
    rejected: z
      .array(z.object({ option: z.string().min(1), reason: z.string().min(1) }).strict())
      .min(1),
    /** Zero for the first step; a wait the Executor turns into a delayed job. */
    delayMs: z.number().int().min(0),
    /**
     * Money this action gives away. Any amount above zero makes the plan a
     * question for a human rather than something Boa may do (D-66).
     */
    concessionPaise: z.number().int().min(0).default(0),
    discountPercent: z.number().min(0).max(100).default(0),
    source: z.enum(["playbook", "llm"]),
  })
  .strict();

export type PlanProposal = z.infer<typeof planProposalSchema>;

export class NoPlanAvailableError extends Error {
  constructor(readonly caseId: number, message: string) {
    super(message);
    this.name = "NoPlanAvailableError";
  }
}

@Injectable()
export class PlannerService {
  /**
   * The next rung of the ladder for this case.
   *
   * `exclude` carries the channels the gate has already refused on this pass,
   * so a spent voice cap moves the agent down the ladder instead of ending the
   * case — the ladder is a preference order, not a fixed script.
   */
  propose(
    record: Case,
    options: {
      degraded?: boolean;
      exclude?: readonly PolicyChannel[];
      /** Channels the customer cannot be reached on at all, as opposed to refused this pass. */
      unreachable?: readonly PolicyChannel[];
      /** A rung a human asked for (D-145). The gate still decides whether it may run. */
      channel?: PolicyChannel;
    } = {},
  ): PlanProposal {
    const attempt = record.attemptsUsed + 1;
    const exclude = new Set(options.exclude ?? []);

    // A concession is never Boa's idea. It is only ever an answer to a customer
    // who said the price was the problem, which is why it hangs off a timestamp
    // written by the inbound classifier rather than off anything the planner
    // could infer on its own (D-71 closed).
    const concession = concessionRung(record, exclude);
    if (concession) return planProposalSchema.parse({ ...concession, attempt });

    const ladder = ladderFor(record.type, record.rootCause);

    // Start at this attempt's rung and walk down; anything already refused on
    // this pass is skipped rather than retried into the same refusal.
    const candidates = [
      ...ladder.slice(Math.min(attempt - 1, ladder.length - 1)),
      ...ladder,
    ].filter((channel) => !exclude.has(channel));

    const channel =
      options.channel && !exclude.has(options.channel) ? options.channel : candidates[0];

    if (!channel) {
      throw new NoPlanAvailableError(
        record.id,
        "Every channel in this playbook has been refused for this case.",
      );
    }

    const narration: PlanNarration = narrate(channel, {
      type: record.type,
      rootCause: record.rootCause,
      attempt,
      attemptCap: record.attemptCap,
      degraded: options.degraded ?? record.degradationIncidentId !== null,
      unreachable: options.unreachable,
    });

    return planProposalSchema.parse({
      channel,
      attempt,
      ...narration,
      delayMs: record.attemptsUsed === 0 ? openingDelayMs(record.type, record.rootCause) : 0,
      concessionPaise: 0,
      discountPercent: 0,
      source: "playbook",
    });
  }

  /** The copy context an adapter needs, assembled from the case and its customer. */
  copyContext(record: Case, customer: Customer, merchantName: string, attempt: number): CopyContext {
    return {
      caseId: record.id,
      type: record.type,
      rootCause: record.rootCause,
      amountPaise: record.amountPaise,
      customerName: customer.name,
      merchantName,
      hinglish: customer.languagePref.startsWith("hi"),
      attempt,
    };
  }
}

/**
 * The rung that offers money, and the two conditions that let it exist.
 *
 * A discount is the only action in the product that costs the merchant
 * something even when it works, so it is bounded twice over. It is proposed
 * only when the customer themselves raised the price — `discountRequestedAt` is
 * set by the inbound classifier, never inferred — and it is proposed only once,
 * because a case that has already been to the approvals queue for a concession
 * and come back is not improved by asking again.
 *
 * The percentage is deliberately under the pack's 15% cap rather than at it: an
 * agent that always asks for the maximum a human may grant is an agent that has
 * stopped exercising judgement, and the gate would be rubber-stamping.
 */
const CONCESSION_PERCENT = 10;

function concessionRung(
  record: Case,
  exclude: ReadonlySet<PolicyChannel>,
): Omit<PlanProposal, "attempt"> | null {
  if (!record.discountRequestedAt) return null;
  // A concession answers an objection the customer has already made, which
  // means at least one contact has landed. It is never an opening move.
  if (record.attemptsUsed === 0) return null;

  const channel: PolicyChannel = exclude.has("WHATSAPP") ? "EMAIL" : "WHATSAPP";
  if (exclude.has(channel)) return null;

  const concessionPaise = Math.round((record.amountPaise * CONCESSION_PERCENT) / 100);

  return {
    channel,
    chosen: `Offer ${CONCESSION_PERCENT}% off to close it — needs a human`,
    because:
      "The customer answered the last nudge by objecting to the price, which is the only signal that justifies giving money away. Boa may not grant it: every concession, at any size, is a merchant's decision.",
    rejected: [
      {
        option: "Send another plain reminder",
        reason: "The objection was to the amount, so repeating the amount answers nothing",
      },
      {
        option: "Grant the discount and send it",
        reason: "There is no threshold under which the agent may give away the merchant's money",
      },
    ],
    delayMs: 0,
    concessionPaise,
    discountPercent: CONCESSION_PERCENT,
    source: "playbook",
  };
}
