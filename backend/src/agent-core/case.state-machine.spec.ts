import type { CaseStage } from "@prisma/client";

import { CaseStateMachine, IllegalCaseTransitionError } from "./case.state-machine";

const ALL: CaseStage[] = [
  "detected",
  "diagnosed",
  "intervening",
  "waiting",
  "escalated",
  "promised",
  "recovered",
  "halted",
  "exhausted",
];

describe("CaseStateMachine", () => {
  const machine = new CaseStateMachine();

  it("knows every stage in the vocabulary", () => {
    expect(machine.stages.sort()).toEqual([...ALL].sort());
  });

  it("walks the happy path a recovered case actually takes", () => {
    const path: CaseStage[] = ["detected", "diagnosed", "intervening", "recovered"];

    for (let i = 0; i < path.length - 1; i += 1) {
      expect(machine.canTransition(path[i], path[i + 1])).toBe(true);
    }
  });

  it("walks the retry loop: intervening -> waiting -> intervening", () => {
    expect(machine.canTransition("intervening", "waiting")).toBe(true);
    expect(machine.canTransition("waiting", "intervening")).toBe(true);
  });

  it("lets an approval resume an escalated case", () => {
    expect(machine.canTransition("escalated", "intervening")).toBe(true);
  });

  it("lets a promise be kept or broken", () => {
    expect(machine.canTransition("promised", "recovered")).toBe(true);
    expect(machine.canTransition("promised", "escalated")).toBe(true);
  });

  describe("terminal stages", () => {
    it("treats recovered as final — nothing follows the money arriving", () => {
      expect(machine.isFinal("recovered")).toBe(true);
      for (const stage of ALL) {
        expect(machine.canTransition("recovered", stage)).toBe(false);
      }
    });

    it("still lets a halted or exhausted case be paid", () => {
      expect(machine.canTransition("halted", "recovered")).toBe(true);
      expect(machine.canTransition("exhausted", "recovered")).toBe(true);
    });

    it("accepts the money arriving from every stage that is not already it", () => {
      // A payment link can be paid at any moment, including between detection
      // and diagnosis. Refusing to record that would be refusing revenue.
      for (const stage of ALL.filter((value) => value !== "recovered")) {
        expect(machine.canTransition(stage, "recovered")).toBe(true);
      }
    });

    it("never lets a halted case resume being chased", () => {
      for (const stage of ["intervening", "waiting", "diagnosed", "promised"] as CaseStage[]) {
        expect(machine.canTransition("halted", stage)).toBe(false);
        expect(machine.canTransition("exhausted", stage)).toBe(false);
      }
    });

    it("reports which stages the agent is done with", () => {
      expect(machine.isAgentTerminal("recovered")).toBe(true);
      expect(machine.isAgentTerminal("halted")).toBe(true);
      expect(machine.isAgentTerminal("exhausted")).toBe(true);
      expect(machine.isAgentTerminal("waiting")).toBe(false);
    });
  });

  describe("illegal moves", () => {
    it("refuses to skip diagnosis and start intervening", () => {
      expect(machine.canTransition("detected", "intervening")).toBe(false);
    });

    it("refuses to move a case to itself", () => {
      for (const stage of ALL) {
        expect(machine.canTransition(stage, stage)).toBe(false);
      }
    });

    it("throws with the offending pair and the legal alternatives", () => {
      expect(() => machine.assertTransition("detected", "promised")).toThrow(
        IllegalCaseTransitionError,
      );

      try {
        machine.assertTransition("detected", "promised");
        fail("expected a throw");
      } catch (error) {
        const response = (error as IllegalCaseTransitionError).getResponse() as {
          error: string;
          allowed: string[];
        };
        expect(response.error).toContain("detected -> promised");
        expect(response.allowed).toEqual(["diagnosed", "escalated", "halted", "recovered"]);
      }
    });
  });

  it("exhaustively agrees with itself: every allowed pair passes assert, every other throws", () => {
    for (const from of ALL) {
      const allowed = machine.allowedFrom(from);

      for (const to of ALL) {
        if (allowed.includes(to)) {
          expect(() => machine.assertTransition(from, to)).not.toThrow();
        } else {
          expect(() => machine.assertTransition(from, to)).toThrow(IllegalCaseTransitionError);
        }
      }
    }
  });
});
