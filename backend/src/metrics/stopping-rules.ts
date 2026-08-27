import type { PolicyCheck } from "../policy/policy-gate.evaluate";

/**
 * Every rule in the pack, with the number of times it stopped something.
 *
 * Two different questions are being counted here and conflating them would make
 * the table meaningless. A *non-terminal* rule refuses one action and leaves the
 * case alive — quiet hours defers a message to 09:00, a spent channel sends the
 * agent down the ladder — so the honest unit is the action it stopped, counted
 * from the gate's own decision rows. A *terminal* rule ends the case, and a case
 * can only end once, so the unit is the case; counting decisions there would
 * report a single exhausted case three times if the gate happened to be asked
 * three times on its way out.
 *
 * Rows that fired zero times stay in the table. A guardrail list showing only
 * the rules that triggered is a guardrail list you cannot audit: the reader
 * cannot tell a rule that held from a rule that is not there.
 */

export type RuleFiring = {
  key: string;
  rule: string;
  /** What happened to the case when it fired. */
  effect: string;
  fired: number;
  /** Terminal rules close a case; the rest only move it. */
  terminal: boolean;
  /** Cannot be switched off in the Policies UI. */
  locked?: boolean;
  /** Counted from the batch rather than authored. */
  derived: boolean;
};

/** The gate check whose `block` verdict means this rule fired. */
export type RuleSource = {
  key: string;
  rule: string;
  effect: string;
  terminal: boolean;
  locked?: boolean;
  /** Name of the check in `PolicyCheck[]`, or null when the rule fires elsewhere. */
  check: string | null;
  /** Narrows a check that carries several rules, by matching its note. */
  noteContains?: string;
};

export const RULE_SOURCES: RuleSource[] = [
  {
    key: "quiet_hours",
    rule: "Quiet hours · 21:00–09:00 IST",
    effect: "Contact deferred to 09:00 · silent retries exempt",
    terminal: false,
    check: "Quiet hours",
  },
  {
    key: "cool_down",
    rule: "Cool-down · 20h between contacts",
    effect: "Contact deferred · never two nudges in one afternoon",
    terminal: false,
    check: "Cool-down",
  },
  {
    key: "channel_cap",
    rule: "Per-channel cap · max 1 voice call",
    effect: "Fell back to the next cheapest channel",
    terminal: false,
    check: "Channel cap",
  },
  {
    key: "mandate_cap",
    rule: "Mandate re-presentation · 3 per cycle, spaced",
    effect: "Held to the next billing cycle · RBI e-mandate discipline",
    terminal: false,
    check: "Re-presentation spacing",
  },
  {
    key: "confidence_floor",
    rule: "Confidence floor · 0.60",
    effect: "Escalated to a human instead of guessing a cause",
    terminal: false,
    // Counted from the abstentions rather than from the gate. The floor is
    // applied by the Diagnoser, which escalates the case before anything is
    // ever planned on it, so on most of the cases it protects the gate is never
    // asked and a gate-derived count reports a confident zero (B-30).
    check: null,
  },
  {
    key: "attempt_cap",
    rule: "Attempt cap · 4 per case, 3 for mandates",
    effect: "Closed EXHAUSTED with the reason written to the ledger",
    terminal: true,
    check: "Attempt cap",
  },
  {
    key: "opt_out",
    rule: "Opt-out keyword · STOP, UNSUBSCRIBE, Hindi equivalents",
    effect: "HALTED on every channel, permanently, for that customer",
    terminal: true,
    locked: true,
    check: "Opt-out",
  },
  {
    key: "sentiment",
    rule: "Negative-sentiment halt",
    effect: "HALTED and handed to a human",
    terminal: true,
    check: "Sentiment halt",
  },
  {
    key: "deadline",
    rule: "Deadline expiry",
    effect: "Closed EXHAUSTED · stale debts are never chased",
    terminal: true,
    check: "Deadline",
  },
  {
    key: "override",
    rule: "Human override · refused escalation or approved stand-down",
    effect: "Agent stood down · the decision and its reason are in the ledger",
    terminal: true,
    // A merchant decision, not a gate verdict, so there is no check to read.
    // The per-case manual pause lands with the Control Tower controls in
    // Stage 9 and will be counted here too.
    check: null,
  },
];

export type DecisionRow = {
  caseId: number;
  checks: PolicyCheck[];
};

/** What the batch knows about a closed case beyond the gate's own record. */
export type ClosedCase = {
  id: number;
  /** True when the customer is opted out, whatever else also applied. */
  optedOut: boolean;
  /** True when the last reply was classified strongly negative. */
  negativeReply: boolean;
  /**
   * True when a person ended it: a refused escalation, or an approved
   * stand-down.
   *
   * Kept apart from the sentiment halt because they are not the same event, and
   * the first version of this table conflated them. A hardship reply is
   * classified negative, so a stand-down a merchant *approved* looked exactly
   * like the agent halting on tone, and a quarter of one batch was reported
   * under a rule that had not fired (B-30).
   */
  humanClosed: boolean;
  /** Diagnosed under the confidence floor, so nothing was planned on it. */
  abstained: boolean;
  closed: boolean;
};

/**
 * The precedence that decides which terminal rule a case is attributed to.
 *
 * A closed case very often satisfies two of these at once — an exhausted case
 * has usually also run past its deadline, and a customer who opted out was
 * frequently on their last attempt anyway. Counting it under both would report
 * more closures than the batch has cases, which is the arithmetic error a
 * guardrail table cannot survive.
 *
 * The order is the gate's own outcome ranking: a halt outranks an exhaustion,
 * because a halt is a decision about the person and an exhaustion is only a
 * decision about the budget. Within the halts, the opt-out outranks sentiment
 * for the same reason it cannot be switched off.
 */
const TERMINAL_PRECEDENCE = [
  "opt_out",
  "override",
  "sentiment",
  "attempt_cap",
  "deadline",
] as const;

export function countFirings(decisions: DecisionRow[], closed: ClosedCase[]): RuleFiring[] {
  const abstentions = closed.filter((row) => row.abstained).length;
  const blockedBy = new Map<number, Set<string>>();

  for (const decision of decisions) {
    for (const check of decision.checks) {
      if (check.verdict !== "block") continue;
      const key = RULE_SOURCES.find((source) => source.check === check.name)?.key;
      if (!key) continue;

      const seen = blockedBy.get(decision.caseId) ?? new Set<string>();
      seen.add(key);
      blockedBy.set(decision.caseId, seen);
    }
  }

  // Each closed case is attributed to exactly one rule, and only closed cases
  // are attributed at all: a quiet-hours block on a case that later recovered
  // did not close anything.
  const terminal: Record<string, number> = {
    opt_out: 0,
    override: 0,
    sentiment: 0,
    attempt_cap: 0,
    deadline: 0,
  };

  for (const row of closed) {
    if (!row.closed) continue;

    const blocks = blockedBy.get(row.id) ?? new Set<string>();
    const key = TERMINAL_PRECEDENCE.find((candidate) => {
      if (candidate === "opt_out") return row.optedOut || blocks.has("opt_out");
      // A human decision outranks the agent's own reading of the reply that
      // prompted it: a merchant who approved a stand-down ended this case, and
      // reporting it as a sentiment halt would credit a rule for a judgement.
      if (candidate === "override") return row.humanClosed;
      // A negative reply halts the case inside the classifier, without a gate
      // check to record it, so the case's own sentiment is the evidence here.
      if (candidate === "sentiment") return row.negativeReply || blocks.has("sentiment");
      return blocks.has(candidate);
    });

    if (key) terminal[key] += 1;
  }

  return RULE_SOURCES.map((source) => {
    if (source.terminal) {
      return {
        key: source.key,
        rule: source.rule,
        effect: source.effect,
        fired: terminal[source.key] ?? 0,
        terminal: true,
        ...(source.locked ? { locked: true } : {}),
        derived: true,
      };
    }

    // The confidence floor is applied before the gate is ever asked, so its
    // count comes from the cases it protected rather than from a decision row.
    if (source.key === "confidence_floor") {
      return {
        key: source.key,
        rule: source.rule,
        effect: source.effect,
        fired: abstentions,
        terminal: false,
        derived: true,
      };
    }

    const fired = decisions.filter((decision) =>
      decision.checks.some(
        (check) =>
          check.name === source.check &&
          check.verdict === "block" &&
          (source.noteContains === undefined ||
            check.note.toLowerCase().includes(source.noteContains)),
      ),
    ).length;

    return {
      key: source.key,
      rule: source.rule,
      effect: source.effect,
      fired,
      terminal: false,
      ...(source.locked ? { locked: true } : {}),
      derived: true,
    };
  });
}
