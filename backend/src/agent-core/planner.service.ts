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
    options: { degraded?: boolean; exclude?: readonly PolicyChannel[] } = {},
  ): PlanProposal {
    const attempt = record.attemptsUsed + 1;
    const ladder = ladderFor(record.type, record.rootCause);
    const exclude = new Set(options.exclude ?? []);

    // Start at this attempt's rung and walk down; anything already refused on
    // this pass is skipped rather than retried into the same refusal.
    const candidates = [
      ...ladder.slice(Math.min(attempt - 1, ladder.length - 1)),
      ...ladder,
    ].filter((channel) => !exclude.has(channel));

    const channel = candidates[0];

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
    });

    return planProposalSchema.parse({
      channel,
      attempt,
      ...narration,
      delayMs: record.attemptsUsed === 0 ? openingDelayMs(record.type, record.rootCause) : 0,
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
