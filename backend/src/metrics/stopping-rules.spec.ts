import type { PolicyCheck } from "../policy/policy-gate.evaluate";
import type { PolicyPack } from "../policy/policy-pack";
import { countFirings, RULE_SOURCES, type ClosedCase, type DecisionRow } from "./stopping-rules";

/**
 * The guardrail table, and the arithmetic it cannot get wrong.
 *
 * One property matters more than any count here: a closed case is attributed to
 * exactly one rule. Two rules very often apply at once — an exhausted case has
 * usually also run past its deadline — and an earlier version of this table
 * counted both, so a thirty-case batch reported twenty-two closures. A
 * guardrail table that totals more endings than the batch has cases is a table
 * a panelist stops reading.
 */

const block = (name: string, note = "blocked"): PolicyCheck => ({
  name,
  verdict: "block",
  note,
});

const pass = (name: string): PolicyCheck => ({ name, verdict: "pass", note: "fine" });

const closed = (id: number, overrides: Partial<ClosedCase> = {}): ClosedCase => ({
  id,
  optedOut: false,
  negativeReply: false,
  humanClosed: false,
  abstained: false,
  closed: true,
  ...overrides,
});

describe("the rule table itself", () => {
  it("lists every rule, including the ones that never fired", () => {
    const firings = countFirings([], []);

    expect(firings).toHaveLength(RULE_SOURCES.length);
    expect(firings.map((row) => row.key)).toEqual(RULE_SOURCES.map((row) => row.key));
    expect(firings.every((row) => row.fired === 0)).toBe(true);
  });

  it("marks the opt-out as locked, because it is the one with no switch", () => {
    const optOut = countFirings([], []).find((row) => row.key === "opt_out");
    expect(optOut?.locked).toBe(true);
  });

  it("declares every count as derived, because every count is", () => {
    expect(countFirings([], []).every((row) => row.derived)).toBe(true);
  });
});

describe("non-terminal rules are counted per action stopped", () => {
  it("counts one firing per decision, because each refused one send", () => {
    const decisions: DecisionRow[] = [
      { caseId: 1, checks: [block("Quiet hours"), pass("Cool-down")] },
      { caseId: 1, checks: [block("Quiet hours")] },
      { caseId: 2, checks: [block("Quiet hours")] },
    ];

    const quiet = countFirings(decisions, []).find((row) => row.key === "quiet_hours");

    // Two deferrals on one case are two messages that did not go out at 23:00.
    expect(quiet?.fired).toBe(3);
  });

  it("ignores checks that passed", () => {
    const decisions: DecisionRow[] = [{ caseId: 1, checks: [pass("Cool-down"), pass("Channel cap")] }];
    const firings = countFirings(decisions, []);

    expect(firings.find((row) => row.key === "cool_down")?.fired).toBe(0);
    expect(firings.find((row) => row.key === "channel_cap")?.fired).toBe(0);
  });

  it("counts the confidence floor from the cases it protected, not from the gate", () => {
    // The Diagnoser applies the floor and escalates before anything is ever
    // planned, so on most of these cases the gate is never asked. A
    // gate-derived count reported a confident zero on a batch with nineteen
    // abstentions in it (B-30).
    const cases = [closed(1, { abstained: true }), closed(2, { abstained: true }), closed(3)];

    expect(countFirings([], cases).find((row) => row.key === "confidence_floor")?.fired).toBe(2);
  });
});

describe("terminal rules are counted per case, exactly once", () => {
  it("attributes a case that satisfies two rules to the more decisive one", () => {
    const decisions: DecisionRow[] = [
      { caseId: 7, checks: [block("Attempt cap"), block("Deadline")] },
    ];

    const firings = countFirings(decisions, [closed(7)]);

    expect(firings.find((row) => row.key === "attempt_cap")?.fired).toBe(1);
    expect(firings.find((row) => row.key === "deadline")?.fired).toBe(0);
  });

  it("lets an opt-out outrank everything, because it is about the person", () => {
    const decisions: DecisionRow[] = [
      { caseId: 7, checks: [block("Attempt cap"), block("Opt-out"), block("Deadline")] },
    ];

    const firings = countFirings(decisions, [closed(7, { optedOut: true, negativeReply: true })]);

    expect(firings.find((row) => row.key === "opt_out")?.fired).toBe(1);
    expect(firings.find((row) => row.key === "sentiment")?.fired).toBe(0);
    expect(firings.find((row) => row.key === "attempt_cap")?.fired).toBe(0);
  });

  it("credits a merchant, not a rule, when a person ended the case", () => {
    // A hardship reply is classified negative, so an approved stand-down looks
    // exactly like a sentiment halt from the outside. Attributing it to the
    // rule would credit a guardrail for somebody else's judgement.
    const firings = countFirings([], [closed(11, { negativeReply: true, humanClosed: true })]);

    expect(firings.find((row) => row.key === "override")?.fired).toBe(1);
    expect(firings.find((row) => row.key === "sentiment")?.fired).toBe(0);
  });

  it("counts a sentiment halt the classifier made without ever asking the gate", () => {
    // A strongly negative reply halts the case inside `InboundService`, so
    // there is no gate decision to read. Counting only gate blocks would report
    // zero sentiment halts on a batch that was full of them.
    const firings = countFirings([], [closed(9, { negativeReply: true })]);

    expect(firings.find((row) => row.key === "sentiment")?.fired).toBe(1);
  });

  it("never counts a case that is still open", () => {
    const decisions: DecisionRow[] = [{ caseId: 3, checks: [block("Attempt cap")] }];

    // A quiet-hours block on a case that later recovered did not close
    // anything, and neither did an attempt-cap check on a case still in flight.
    const firings = countFirings(decisions, [closed(3, { closed: false })]);

    expect(firings.find((row) => row.key === "attempt_cap")?.fired).toBe(0);
  });

  it("totals no more endings than the batch has closed cases", () => {
    const cases = Array.from({ length: 40 }, (_, i) =>
      closed(i, { optedOut: i % 7 === 0, negativeReply: i % 5 === 0, closed: i % 3 !== 0 }),
    );

    const decisions: DecisionRow[] = cases.flatMap((row) => [
      { caseId: row.id, checks: [block("Attempt cap"), block("Deadline")] },
      { caseId: row.id, checks: [block("Quiet hours")] },
    ]);

    const firings = countFirings(decisions, cases);
    const endings = firings
      .filter((row) => row.terminal)
      .reduce((sum, row) => sum + row.fired, 0);

    expect(endings).toBeLessThanOrEqual(cases.filter((row) => row.closed).length);
  });
});

describe("the table states the pack that was actually in force", () => {
  const RUPEE = 100;
  const PACK: PolicyPack = {
    contact: {
      maxAttempts: 4,
      coolDownHours: 20,
      channelCaps: { WHATSAPP: 2, EMAIL: 2, VOICE: 1, RETRY: 2 },
    },
    quiet: { startMinutes: 21 * 60, endMinutes: 9 * 60, exemptSilentRetries: true },
    rules: { opt_out: true, sentiment: true, deadline: true, attempt_cap: true },
    sentimentThreshold: 0.7,
    escalation: {
      discountCapPercent: 15,
      valueThresholdPaise: 25_000 * RUPEE,
      b2bAlways: true,
      confidenceFloor: 0.6,
      hardship: true,
    },
    mandate: { maxPerCycle: 3, spacingDays: 3, alignToPayday: true },
    channels: { WHATSAPP: true, EMAIL: true, VOICE: true, RETRY: true },
  };

  const labelOf = (key: string, pack: PolicyPack): string =>
    countFirings([], [], pack).find((row) => row.key === key)!.rule;

  it("reads the cool-down off the pack rather than the shipped default", () => {
    expect(labelOf("cool_down", PACK)).toBe("Cool-down · 20h between contacts");

    const loosened: PolicyPack = { ...PACK, contact: { ...PACK.contact, coolDownHours: 6 } };
    expect(labelOf("cool_down", loosened)).toBe("Cool-down · 6h between contacts");
  });

  it("follows every other editable bound too", () => {
    const edited: PolicyPack = {
      ...PACK,
      contact: { ...PACK.contact, maxAttempts: 7, channelCaps: { ...PACK.contact.channelCaps, VOICE: 2 } },
      quiet: { ...PACK.quiet, startMinutes: 22 * 60, endMinutes: 8 * 60 },
      escalation: { ...PACK.escalation, confidenceFloor: 0.75 },
      mandate: { ...PACK.mandate, maxPerCycle: 2 },
    };

    expect(labelOf("quiet_hours", edited)).toBe("Quiet hours · 22:00–08:00 IST");
    expect(labelOf("channel_cap", edited)).toBe("Per-channel cap · max 2 voice calls");
    expect(labelOf("confidence_floor", edited)).toBe("Confidence floor · 0.75");
    expect(labelOf("attempt_cap", edited)).toBe("Attempt cap · 7 per case, 2 for mandates");
    expect(labelOf("mandate_cap", edited)).toBe("Mandate re-presentation · 2 per cycle, spaced");
  });

  it("falls back to the authored wording when no pack is supplied", () => {
    const authored = RULE_SOURCES.find((source) => source.key === "cool_down")!.rule;
    expect(countFirings([], []).find((row) => row.key === "cool_down")!.rule).toBe(authored);
  });

  it("leaves the rules that carry no number alone", () => {
    expect(labelOf("opt_out", PACK)).toBe(
      "Opt-out keyword · STOP, UNSUBSCRIBE, Hindi equivalents",
    );
  });
});
