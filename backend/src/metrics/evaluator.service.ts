import { Injectable } from "@nestjs/common";
import type { DiagnosisMethod, RootCause } from "@prisma/client";

import { PrismaService } from "../prisma/prisma.service";

/**
 * The grade, and the only place the answer key is opened.
 *
 * `sim_ground_truth` is written by the simulator and read here, at the end of a
 * run, by a module the agent has no import path into (ADR-10). That separation
 * is the whole reason an accuracy figure from this file is worth anything: if
 * `agent-core` could reach the true cause — even to log it — a reviewer would
 * be right to assume it eventually did.
 *
 * Three populations come out of a batch and they are counted separately on
 * purpose. *Undiagnosed* cases never reached the diagnoser before the horizon;
 * that is an absence of a diagnosis, not a wrong one, and folding it into the
 * error rate would punish the agent for a case it had not got to. *Abstained*
 * cases were diagnosed under the confidence floor and escalated instead of
 * guessed; counting those as errors would make the floor look like a defect
 * when it is the feature. What is left is what the agent actually claimed, and
 * that is what gets graded.
 */

export type MethodGrade = {
  method: DiagnosisMethod;
  graded: number;
  correct: number;
  accuracy: number;
};

export type Confusion = { truth: RootCause; called: RootCause; count: number };

export type Grading = {
  total: number;
  /** Never reached the diagnoser before the batch closed. */
  undiagnosed: number;
  /** Diagnosed, but under the confidence floor — escalated rather than guessed. */
  abstained: number;
  graded: number;
  correct: number;
  wrong: number;
  accuracy: number;
  byMethod: MethodGrade[];
  confusions: Confusion[];
};

/** How many confusion pairs the report prints. The tail is a long list of ones. */
const CONFUSIONS_SHOWN = 5;

@Injectable()
export class EvaluatorService {
  constructor(private readonly prisma: PrismaService) {}

  async grade(simRunId: string): Promise<Grading> {
    const rows = await this.prisma.simGroundTruth.findMany({
      where: { simRunId },
      select: {
        trueRootCause: true,
        case: {
          select: { rootCause: true, diagnosisMethod: true, diagnosisConfidence: true },
        },
      },
      orderBy: { caseIndex: "asc" },
    });

    const total = rows.length;
    let undiagnosed = 0;
    let abstained = 0;

    const byMethod = new Map<DiagnosisMethod, { graded: number; correct: number }>([
      ["RULES", { graded: 0, correct: 0 }],
      ["LLM", { graded: 0, correct: 0 }],
    ]);

    const confusions = new Map<string, Confusion>();

    for (const row of rows) {
      const method = row.case.diagnosisMethod;
      const called = row.case.rootCause;

      if (method === null || called === null) {
        undiagnosed += 1;
        continue;
      }

      // UNKNOWN is the agent declining to answer, which the confidence floor
      // turns into an escalation. It is not a wrong answer and is not graded.
      if (called === "UNKNOWN") {
        abstained += 1;
        continue;
      }

      const bucket = byMethod.get(method)!;
      bucket.graded += 1;

      if (called === row.trueRootCause) {
        bucket.correct += 1;
        continue;
      }

      const key = `${row.trueRootCause}->${called}`;
      const seen = confusions.get(key);
      if (seen) seen.count += 1;
      else confusions.set(key, { truth: row.trueRootCause, called, count: 1 });
    }

    const methods: MethodGrade[] = [...byMethod.entries()].map(([method, counts]) => ({
      method,
      graded: counts.graded,
      correct: counts.correct,
      accuracy: counts.graded === 0 ? 0 : counts.correct / counts.graded,
    }));

    const graded = methods.reduce((sum, row) => sum + row.graded, 0);
    const correct = methods.reduce((sum, row) => sum + row.correct, 0);

    return {
      total,
      undiagnosed,
      abstained,
      graded,
      correct,
      wrong: graded - correct,
      accuracy: graded === 0 ? 0 : correct / graded,
      byMethod: methods,
      confusions: [...confusions.values()]
        // Ties broken by name so the same batch produces the same report twice.
        .sort(
          (a, b) =>
            b.count - a.count ||
            a.truth.localeCompare(b.truth) ||
            a.called.localeCompare(b.called),
        )
        .slice(0, CONFUSIONS_SHOWN),
    };
  }
}
