import type { DiagnosisMethod, RootCause } from "@prisma/client";

import type { PrismaService } from "../prisma/prisma.service";
import { EvaluatorService } from "./evaluator.service";

/**
 * The grade, and the three populations it refuses to conflate.
 *
 * The accuracy figure in the evidence report is the one a panelist is most
 * likely to interrogate, and the interesting question is not "how high is it"
 * but "over what". A grader that counted the cases it never reached as errors
 * would punish the agent for a queue; one that counted its abstentions as
 * errors would punish it for the confidence floor, which is the feature. Both
 * would be defensible-sounding and both would be wrong, so the split is
 * asserted here rather than left to the reader of the query.
 */

type Row = {
  trueRootCause: RootCause;
  case: {
    rootCause: RootCause | null;
    diagnosisMethod: DiagnosisMethod | null;
    diagnosisConfidence: number | null;
  };
};

function evaluatorOver(rows: Row[]): EvaluatorService {
  const prisma = {
    simGroundTruth: { findMany: async () => rows },
  } as unknown as PrismaService;

  return new EvaluatorService(prisma);
}

const graded = (
  truth: RootCause,
  called: RootCause,
  method: DiagnosisMethod = "RULES",
): Row => ({
  trueRootCause: truth,
  case: { rootCause: called, diagnosisMethod: method, diagnosisConfidence: 0.9 },
});

const undiagnosed = (truth: RootCause): Row => ({
  trueRootCause: truth,
  case: { rootCause: null, diagnosisMethod: null, diagnosisConfidence: null },
});

const abstained = (truth: RootCause): Row => ({
  trueRootCause: truth,
  case: { rootCause: "UNKNOWN", diagnosisMethod: "LLM", diagnosisConfidence: 0.41 },
});

describe("EvaluatorService", () => {
  it("grades only the cases on which the agent actually made a claim", async () => {
    const grade = await evaluatorOver([
      graded("INSUFFICIENT_FUNDS", "INSUFFICIENT_FUNDS"),
      graded("CARD_EXPIRED", "CARD_EXPIRED"),
      graded("BANK_GATEWAY_DEGRADED", "INSUFFICIENT_FUNDS"),
      abstained("MANDATE_REVOKED"),
      undiagnosed("CUSTOMER_DISTRACTED"),
    ]).grade("run");

    expect(grade.total).toBe(5);
    expect(grade.undiagnosed).toBe(1);
    expect(grade.abstained).toBe(1);
    expect(grade.graded).toBe(3);
    expect(grade.correct).toBe(2);
    expect(grade.wrong).toBe(1);
    expect(grade.accuracy).toBeCloseTo(2 / 3);
  });

  it("never counts an abstention as a wrong answer", async () => {
    const grade = await evaluatorOver([
      graded("INSUFFICIENT_FUNDS", "INSUFFICIENT_FUNDS"),
      abstained("MANDATE_REVOKED"),
      abstained("CARD_EXPIRED"),
    ]).grade("run");

    // Declining to guess under the confidence floor is the behaviour the
    // architecture is arguing for. Scoring it as an error would make the report
    // penalise its own guardrail.
    expect(grade.accuracy).toBe(1);
    expect(grade.wrong).toBe(0);
    expect(grade.abstained).toBe(2);
  });

  it("splits the score by lane, so the table and the model are compared", async () => {
    const grade = await evaluatorOver([
      graded("INSUFFICIENT_FUNDS", "INSUFFICIENT_FUNDS", "RULES"),
      graded("CARD_EXPIRED", "CARD_EXPIRED", "RULES"),
      graded("MANDATE_REVOKED", "MANDATE_REVOKED", "RULES"),
      graded("BANK_GATEWAY_DEGRADED", "INSUFFICIENT_FUNDS", "LLM"),
      graded("CUSTOMER_DISTRACTED", "CUSTOMER_DISTRACTED", "LLM"),
    ]).grade("run");

    const rules = grade.byMethod.find((row) => row.method === "RULES")!;
    const llm = grade.byMethod.find((row) => row.method === "LLM")!;

    expect(rules).toEqual({ method: "RULES", graded: 3, correct: 3, accuracy: 1 });
    expect(llm).toEqual({ method: "LLM", graded: 2, correct: 1, accuracy: 0.5 });
  });

  it("reports both lanes even when one of them never ran", async () => {
    const grade = await evaluatorOver([graded("CARD_EXPIRED", "CARD_EXPIRED", "RULES")]).grade("run");

    // "The model was never asked" is a result worth printing, and a row that
    // vanished when its count hit zero would read as an omission.
    expect(grade.byMethod.map((row) => row.method)).toEqual(["RULES", "LLM"]);
    expect(grade.byMethod.find((row) => row.method === "LLM")).toEqual({
      method: "LLM",
      graded: 0,
      correct: 0,
      accuracy: 0,
    });
  });

  it("ranks the confusions by how often they happened", async () => {
    const grade = await evaluatorOver([
      graded("BANK_GATEWAY_DEGRADED", "INSUFFICIENT_FUNDS"),
      graded("BANK_GATEWAY_DEGRADED", "INSUFFICIENT_FUNDS"),
      graded("BANK_GATEWAY_DEGRADED", "INSUFFICIENT_FUNDS"),
      graded("CARD_EXPIRED", "MANDATE_REVOKED"),
      graded("CARD_EXPIRED", "MANDATE_REVOKED"),
      graded("INSUFFICIENT_FUNDS", "CUSTOMER_DISTRACTED"),
    ]).grade("run");

    expect(grade.confusions).toEqual([
      { truth: "BANK_GATEWAY_DEGRADED", called: "INSUFFICIENT_FUNDS", count: 3 },
      { truth: "CARD_EXPIRED", called: "MANDATE_REVOKED", count: 2 },
      { truth: "INSUFFICIENT_FUNDS", called: "CUSTOMER_DISTRACTED", count: 1 },
    ]);
  });

  it("breaks ties by name, so the same batch grades identically twice", async () => {
    const rows = [
      graded("CARD_EXPIRED", "MANDATE_REVOKED"),
      graded("BANK_GATEWAY_DEGRADED", "INSUFFICIENT_FUNDS"),
      graded("INSUFFICIENT_FUNDS", "CUSTOMER_DISTRACTED"),
    ];

    const first = await evaluatorOver(rows).grade("run");
    const second = await evaluatorOver([...rows].reverse()).grade("run");

    expect(first.confusions).toEqual(second.confusions);
  });

  it("survives a batch that produced nothing at all", async () => {
    const grade = await evaluatorOver([]).grade("run");

    expect(grade).toMatchObject({ total: 0, graded: 0, correct: 0, accuracy: 0, confusions: [] });
  });
});
