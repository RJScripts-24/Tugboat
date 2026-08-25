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
 * there is nothing further to decide. `halted` and `exhausted` are terminal for
 * the *agent* but still accept `recovered`, because a customer who opted out or
 * a case that hit its attempt cap can always pay anyway, and a state machine
 * that refused to record that would be refusing to record revenue.
 */
const TRANSITIONS: Record<CaseStage, readonly CaseStage[]> = {
  detected: ["diagnosed", "escalated", "halted"],
  diagnosed: ["intervening", "escalated", "halted", "exhausted"],
  intervening: ["waiting", "promised", "recovered", "escalated", "halted", "exhausted"],
  waiting: ["intervening", "promised", "recovered", "escalated", "halted", "exhausted"],
  escalated: ["intervening", "waiting", "recovered", "halted", "exhausted"],
  promised: ["recovered", "intervening", "escalated", "halted", "exhausted"],
  recovered: [],
  halted: ["recovered"],
  exhausted: ["recovered"],
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
