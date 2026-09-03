import { BadRequestException, Injectable } from "@nestjs/common";
import type { CaseStage } from "@prisma/client";

/**
 * The case lifecycle (ADR-3).
 *
 * Money workflows must be deterministic and inspectable, so the set of legal
 * moves is written down in one table rather than implied by scattered
 * conditionals. The LLM never transitions state: it produces proposals that
 * deterministic code validates and applies through this class.
 */

/**
 * Legal destinations for each stage.
 *
 * `recovered` is the only truly terminal stage — once the money has arrived
 * there is nothing further to decide. Every other stage accepts it, including
 * the two that are terminal for the *agent*: a customer who opted out, a case
 * that hit its attempt cap, and a payment that lands in the ninety seconds
 * between detection and diagnosis can all still pay, and a state machine that
 * refused to record that would be refusing to record revenue. The money
 * arriving is the one transition this table may never decline.
 *
 * `exhausted -> escalated` is the second exception, and it is a human one
 * (D-150). A case that ran out of attempts is finished for the *agent* — it
 * stays in `AGENT_TERMINAL` and nothing schedules another rung — but a merchant
 * who wants to work it themselves has to be able to take it, or "compliant
 * escalation" means only "escalation the agent chose". The cap is not weakened
 * by this: every outbound action still passes the gate, which counts attempts
 * against the pack and refuses a fifth.
 *
 * `halted` now gets the same door, which it did not before B-86. The reasoning
 * against it was that a halted case is one an opt-out or a hostile reply
 * closed, and a click should not reopen that. Two of those three words were
 * wrong: `halted` is also where a delivery that would not go through, a
 * gate refusal with no channel left, and a merchant's own "resolved elsewhere"
 * land, and none of those is the customer withdrawing consent. The opt-out is
 * guarded where it actually lives — `CaseOverridesService` refuses to take a
 * case whose customer replied STOP, and the gate refuses every send to them
 * regardless — rather than by walling off a whole stage from its owner.
 */
const TRANSITIONS: Record<CaseStage, readonly CaseStage[]> = {
  detected: ["diagnosed", "escalated", "halted", "recovered"],
  diagnosed: ["intervening", "escalated", "halted", "exhausted", "recovered"],
  intervening: ["waiting", "promised", "recovered", "escalated", "halted", "exhausted"],
  waiting: ["intervening", "promised", "recovered", "escalated", "halted", "exhausted"],
  escalated: ["intervening", "waiting", "recovered", "halted", "exhausted"],
  promised: ["recovered", "intervening", "escalated", "halted", "exhausted"],
  recovered: [],
  halted: ["recovered", "escalated"],
  exhausted: ["recovered", "escalated"],
};

/** Stages from which the agent will take no further action of its own. */
const AGENT_TERMINAL: readonly CaseStage[] = ["recovered", "halted", "exhausted"];

export class IllegalCaseTransitionError extends BadRequestException {
  constructor(
    readonly from: CaseStage,
    readonly to: CaseStage,
  ) {
    // `message` is set explicitly so logs and stack traces name the offending
    // pair; without it Nest falls back to the class name, which says nothing.
    super({
      error: `Illegal case transition: ${from} -> ${to}`,
      message: `Illegal case transition: ${from} -> ${to}`,
      from,
      to,
      allowed: TRANSITIONS[from],
    });
  }
}

@Injectable()
export class CaseStateMachine {
  canTransition(from: CaseStage, to: CaseStage): boolean {
    return TRANSITIONS[from].includes(to);
  }

  /** Throws rather than returning false: an illegal move is a bug, not a branch. */
  assertTransition(from: CaseStage, to: CaseStage): void {
    if (!this.canTransition(from, to)) {
      throw new IllegalCaseTransitionError(from, to);
    }
  }

  allowedFrom(stage: CaseStage): readonly CaseStage[] {
    return TRANSITIONS[stage];
  }

  /** True when the agent is done with the case, whether or not money arrived. */
  isAgentTerminal(stage: CaseStage): boolean {
    return AGENT_TERMINAL.includes(stage);
  }

  isFinal(stage: CaseStage): boolean {
    return TRANSITIONS[stage].length === 0;
  }

  get stages(): CaseStage[] {
    return Object.keys(TRANSITIONS) as CaseStage[];
  }
}
