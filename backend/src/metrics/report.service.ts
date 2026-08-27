import { Injectable } from "@nestjs/common";
import type { CaseStage, CaseType, RootCause } from "@prisma/client";

import { computeStats } from "../approvals/approvals.stats";
import { toCaseRef } from "../common/case-ref";
import { CODE_VERSION } from "../common/version";
import type { PolicyCheck } from "../policy/policy-gate.evaluate";
import type { PolicyPack } from "../policy/policy-pack";
import { PrismaService } from "../prisma/prisma.service";
import { DIFFICULTY, type DifficultyKey } from "../simulator/difficulty";
import {
  baselineArm,
  costPer100,
  naiveArm,
  type ArmKey,
  type ArmResult,
} from "../simulator/counterfactuals";
import type { GeneratedCase } from "../simulator/population";
import { ComplianceService, type ComplianceBlock } from "./compliance.service";
import { EvaluatorService, type Grading } from "./evaluator.service";
import { countFirings, type RuleFiring } from "./stopping-rules";

/**
 * The evidence report.
 *
 * Shaped exactly like `buildReportJson` in `frontend/src/lib/simulation-data.ts`
 * so the Simulation Lab renders it without a mapping layer, and written once at
 * the end of a run rather than recomputed on read. That is deliberate: a report
 * is a claim about a batch at a moment, and one that silently re-derived itself
 * from a database that has since moved on would be a different claim wearing
 * the same run id.
 *
 * Three rules govern what may appear in it.
 *
 * Nothing is authored. Every figure is a query over rows the agent wrote while
 * working, or a function of the population the simulator drew before the agent
 * saw anything. There is no constant in this file that stands in for a
 * measurement.
 *
 * The unflattering half is not optional. Exceptions, wrong diagnoses, the
 * confusion pairs and the cost per rupee are in the same object as the headline
 * and are produced by the same pass, so there is no version of this report that
 * has the good numbers without them.
 *
 * And what was measured is distinguished from what was modelled, in the JSON.
 * `armsExecuted` names the arm that actually ran; the other two are
 * counterfactuals and the report says so rather than letting a reader assume
 * three batches were run.
 */

export type Headline = {
  atRiskPaise: number;
  cases: number;
  recoveredPaise: number;
  recoveredCases: number;
  recoveryRate: number;
  baselineRate: number;
  upliftPoints: number;
  /** What the uplift is worth, which is the number a merchant actually cares about. */
  upliftPaise: number;
};

export type TypeResult = {
  type: CaseType;
  cases: number;
  atRiskPaise: number;
  recoveredPaise: number;
  recoveredCases: number;
  rate: number;
};

export type ExceptionGroup = {
  key: string;
  reason: string;
  /** Why it is the honest outcome rather than a defect. */
  note: string;
  cases: number;
  atRiskPaise: number;
  sample: {
    /** The case reference, so a reader can open it in the Control Tower. */
    id: string;
    /**
     * Its position in the generated population.
     *
     * Carried beside the case reference because the two answer different
     * questions. The reference is a database identity and differs between runs
     * of the same seed — autoincrement has no memory — so a report compared
     * byte for byte across a rerun would differ here and nowhere else. The
     * index is the case's identity *in the batch*, and it is stable.
     */
    simIndex: number | null;
    type: CaseType;
    amountPaise: number;
    cause: RootCause;
  }[];
};

export type SimulationReport = {
  schema: "tugboat.simulation.report/1";
  run: {
    id: string;
    seed: number;
    batchSize: number;
    mix: Record<string, number>;
    difficulty: DifficultyKey;
    difficultyAssumptions: (typeof DIFFICULTY)[DifficultyKey];
    arms: ArmKey[];
    /** The one arm that was executed. The others are counterfactuals. */
    armsExecuted: ArmKey[];
    policyVersion: string;
    codeVersion: string;
    horizonDays: number;
    /**
     * Cases that threw while the batch worked them.
     *
     * Reported rather than rounded off. A run that lost four cases to a timed
     * out transaction is a run whose figures are computed over four fewer
     * cases, and a reader is entitled to know that before comparing it with
     * one that lost none.
     */
    caseErrors: number;
  };
  headline: Headline;
  arms: ArmResult[];
  byCaseType: TypeResult[];
  diagnosis: Grading;
  stoppingRules: RuleFiring[];
  compliance: ComplianceBlock;
  escalations: ReturnType<ReportService["escalationShape"]>;
  exceptions: ExceptionGroup[];
  cost: {
    channelPaise: number;
    llmPaise: number;
    /** What the same batch would cost at paid provider rates, not free tiers. */
    projectedPaise: number;
    llmCalls: number;
    tokens: number;
  };
};

const CASE_TYPE_ORDER: CaseType[] = [
  "PAYMENT_FAILED",
  "CHECKOUT_ABANDONED",
  "MANDATE_FAILED",
  "INVOICE_OVERDUE",
];

const OPEN_STAGES: CaseStage[] = [
  "detected",
  "diagnosed",
  "intervening",
  "waiting",
  "escalated",
  "promised",
];

@Injectable()
export class ReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly evaluator: EvaluatorService,
    private readonly compliance: ComplianceService,
  ) {}

  async build(input: {
    runId: string;
    ref: string;
    merchantId: string;
    seed: number;
    difficulty: DifficultyKey;
    mix: Record<string, number>;
    arms: ArmKey[];
    policyVersion: string;
    pack: PolicyPack;
    population: GeneratedCase[];
    /** Which generated case each database id turned into. */
    personaByCaseId: Map<number, GeneratedCase>;
    caseErrors: number;
    startedAtMs: number;
    horizonMs: number;
  }): Promise<SimulationReport> {
    const cases = await this.prisma.case.findMany({
      where: { simRunId: input.runId },
      select: {
        id: true,
        type: true,
        stage: true,
        amountPaise: true,
        recoveredAmountPaise: true,
        rootCause: true,
        diagnosisMethod: true,
        costPaise: true,
        attemptsUsed: true,
        deadlineAt: true,
        lastSentiment: true,
        customer: { select: { optedOutAt: true } },
      },
      orderBy: { id: "asc" },
    });

    const caseIds = cases.map((row) => row.id);

    const [grading, compliance, decisions, actions, llm, approvals] = await Promise.all([
      this.evaluator.grade(input.runId),
      this.compliance.assess(input.merchantId, caseIds, input.pack),
      this.prisma.policyDecision.findMany({
        where: { caseId: { in: caseIds } },
        select: { caseId: true, checks: true },
      }),
      this.prisma.action.findMany({
        where: { caseId: { in: caseIds }, status: "EXECUTED" },
        select: { channel: true, costPaise: true },
      }),
      this.prisma.llmCall.aggregate({
        where: { caseId: { in: caseIds } },
        _sum: { costPaise: true, projectedCostPaise: true, tokensIn: true, tokensOut: true },
        _count: { _all: true },
      }),
      this.prisma.approval.findMany({
        where: { caseId: { in: caseIds } },
        select: {
          caseId: true,
          gate: true,
          decision: true,
          latencySeconds: true,
          atRiskPaise: true,
          concessionPaise: true,
          requestedAt: true,
          case: { select: { recoveredAmountPaise: true } },
        },
      }),
    ]);

    // Cases a person ended: a refused escalation stands the agent down, and an
    // approved hardship offer is sent once and closes the case.
    const humanDecided = new Set(
      approvals
        .filter(
          (row) =>
            row.decision === "rejected" ||
            (row.decision === "approved" && row.gate === "hardship_language"),
        )
        .map((row) => row.caseId),
    );

    const atRiskPaise = cases.reduce((sum, row) => sum + row.amountPaise, 0);
    const recoveredPaise = cases.reduce((sum, row) => sum + row.recoveredAmountPaise, 0);
    const recoveredCases = cases.filter((row) => row.stage === "recovered").length;
    const contacts = actions.filter((row) => row.channel !== "RETRY").length;

    const channelPaise = actions.reduce((sum, row) => sum + row.costPaise, 0);
    const llmPaise = llm._sum.costPaise ?? 0;
    const projectedPaise = channelPaise + (llm._sum.projectedCostPaise ?? 0);

    const armInput = {
      cases: input.population,
      horizonMs: input.horizonMs,
      startedAtMs: input.startedAtMs,
      quiet: input.pack.quiet,
    };

    const baseline = baselineArm(armInput);
    const naive = naiveArm(armInput);

    const tugboatCost = channelPaise + llmPaise;
    const tugboat: ArmResult = {
      key: "tugboat",
      recoveredPaise,
      recoveredCases,
      recoveryRate: atRiskPaise === 0 ? 0 : recoveredPaise / atRiskPaise,
      contacts,
      // Judged by the same threshold the naive arm is: a customer contacted
      // past their own tolerance complains, whoever contacted them.
      complaints: this.complaintsIn(input.personaByCaseId, cases),
      optOuts: cases.filter((row) => row.customer.optedOutAt !== null).length,
      quietHourSends: compliance.counts.quietHourSends,
      costPaise: tugboatCost,
      costPer100Paise: costPer100(tugboatCost, recoveredPaise),
    };

    const arms = [baseline, naive, tugboat].filter((arm) => input.arms.includes(arm.key));

    const headline: Headline = {
      atRiskPaise,
      cases: cases.length,
      recoveredPaise,
      recoveredCases,
      recoveryRate: tugboat.recoveryRate,
      baselineRate: baseline.recoveryRate,
      upliftPoints: (tugboat.recoveryRate - baseline.recoveryRate) * 100,
      upliftPaise: recoveredPaise - baseline.recoveredPaise,
    };

    return {
      schema: "tugboat.simulation.report/1",
      run: {
        id: input.ref,
        seed: input.seed,
        batchSize: cases.length,
        mix: input.mix,
        difficulty: input.difficulty,
        difficultyAssumptions: DIFFICULTY[input.difficulty],
        arms: input.arms,
        armsExecuted: ["tugboat"],
        policyVersion: input.policyVersion,
        codeVersion: CODE_VERSION,
        horizonDays: Math.round(input.horizonMs / 86_400_000),
        caseErrors: input.caseErrors,
      },
      headline,
      arms,
      byCaseType: this.byCaseType(cases),
      diagnosis: grading,
      stoppingRules: countFirings(
        decisions.map((row) => ({
          caseId: row.caseId,
          checks: row.checks as unknown as PolicyCheck[],
        })),
        cases.map((row) => ({
          id: row.id,
          optedOut: row.customer.optedOutAt !== null,
          negativeReply: row.lastSentiment === "negative",
          humanClosed: row.stage === "halted" && humanDecided.has(row.id),
          abstained: row.rootCause === "UNKNOWN",
          closed: row.stage === "halted" || row.stage === "exhausted",
        })),
      ),
      compliance: compliance.block,
      escalations: this.escalationShape(approvals, input.startedAtMs + input.horizonMs),
      exceptions: this.exceptions(cases, input.personaByCaseId, humanDecided),
      cost: {
        channelPaise,
        llmPaise,
        projectedPaise,
        llmCalls: llm._count._all,
        tokens: (llm._sum.tokensIn ?? 0) + (llm._sum.tokensOut ?? 0),
      },
    };
  }

  /* ---------------------------------------------------------------- */

  private byCaseType(cases: ReportCase[]): TypeResult[] {
    return CASE_TYPE_ORDER.map((type) => {
      const rows = cases.filter((row) => row.type === type);
      const at = rows.reduce((sum, row) => sum + row.amountPaise, 0);
      const recovered = rows.reduce((sum, row) => sum + row.recoveredAmountPaise, 0);

      return {
        type,
        cases: rows.length,
        atRiskPaise: at,
        recoveredPaise: recovered,
        recoveredCases: rows.filter((row) => row.stage === "recovered").length,
        rate: at === 0 ? 0 : recovered / at,
      };
    });
  }

  /**
   * What this batch did not get back, grouped by why.
   *
   * Every case is in exactly one group, and that exclusivity is load-bearing:
   * an unrecovered case can satisfy two predicates at once — a diagnosis under
   * the confidence floor that later hit a sentiment halt is both — and a list
   * that counted it twice would total more exceptions than the batch has cases,
   * which is the one arithmetic error this report cannot survive.
   *
   * The order below is an assignment order, not a display order. It runs from
   * the most specific reason a case stopped to the least, because a case that
   * halted on an opt-out is an opt-out even if it had also been escalated for a
   * weak diagnosis: the opt-out is what ended it. Display order is by money
   * left on the table rather than by how flattering the group is.
   */
  private exceptions(
    cases: ReportCase[],
    personaByCaseId: Map<number, GeneratedCase>,
    humanDecided: ReadonlySet<number>,
  ): ExceptionGroup[] {
    const claimed = new Set<number>();

    const take = (predicate: (row: ReportCase) => boolean): ReportCase[] => {
      const rows = cases.filter(
        (row) => row.stage !== "recovered" && !claimed.has(row.id) && predicate(row),
      );
      for (const row of rows) claimed.add(row.id);
      return rows;
    };

    const groups = [
      {
        key: "opt_out",
        reason: "Customer opted out",
        note: "STOP received. Every channel closed for that customer, permanently — the one rule that cannot be switched off.",
        rows: take((row) => row.customer.optedOutAt !== null),
      },
      {
        key: "human_closed",
        reason: "A person ended it",
        note: "A merchant refused the escalation, or approved a stand-down offer that is sent once and followed by nothing. The agent was told to stop, and it stopped.",
        rows: take((row) => row.stage === "halted" && humanDecided.has(row.id)),
      },
      {
        key: "sentiment",
        reason: "Negative sentiment · halted",
        note: "The reply read as hostile or distressed, so the agent stood down and handed the case to a person.",
        rows: take((row) => row.stage === "halted"),
      },
      {
        key: "exhausted",
        reason: "Attempt cap reached",
        note: "Four contacts, no payment, no reply worth another. The agent stopped because it was told to, not because it ran out of ideas.",
        rows: take((row) => row.stage === "exhausted"),
      },
      {
        key: "escalated",
        reason: "Waiting on a human",
        note: "Hardship, a dispute, a concession or a weak diagnosis put the case in front of a person, and it was still there when the horizon closed.",
        rows: take((row) => row.stage === "escalated"),
      },
      {
        key: "abstained",
        reason: "Below the confidence floor",
        note: "The model's best read was under the floor, so nothing was planned on it. An unrecovered case is cheaper than a wrong intervention.",
        rows: take((row) => row.rootCause === "UNKNOWN"),
      },
      {
        key: "undiagnosed",
        reason: "Never diagnosed",
        note: "Still queued for the diagnoser when the batch closed. Not a failure of the diagnosis — an absence of one.",
        rows: take((row) => row.diagnosisMethod === null),
      },
      {
        key: "in_flight",
        reason: "Still in flight at the horizon",
        note: "Inside its bounds and still being worked when the ten-day window closed. Reported as unfinished rather than counted as a loss.",
        rows: take((row) => OPEN_STAGES.includes(row.stage)),
      },
    ];

    return groups
      .filter((group) => group.rows.length > 0)
      .map((group) => ({
        key: group.key,
        reason: group.reason,
        note: group.note,
        cases: group.rows.length,
        atRiskPaise: group.rows.reduce((sum, row) => sum + row.amountPaise, 0),
        sample: [...group.rows]
          // The largest few, by money, so the worst of it is what you see.
          // Ties broken by the case's position in the batch rather than by its
          // database id, so a rerun of the same seed picks the same three.
          .sort(
            (a, b) =>
              b.amountPaise - a.amountPaise ||
              (personaByCaseId.get(a.id)?.index ?? a.id) -
                (personaByCaseId.get(b.id)?.index ?? b.id),
          )
          .slice(0, 3)
          .map((row) => ({
            id: toCaseRef(row.id),
            simIndex: personaByCaseId.get(row.id)?.index ?? null,
            type: row.type,
            amountPaise: row.amountPaise,
            cause: row.rootCause ?? ("UNKNOWN" as RootCause),
          })),
      }))
      .sort((a, b) => b.atRiskPaise - a.atRiskPaise || a.key.localeCompare(b.key));
  }

  /** Read straight off the approvals rows — the same requests, counted once. */
  private escalationShape(approvals: ApprovalRow[], horizonEndMs: number) {
    const stats = computeStats(
      approvals
        .filter((row) => row.decision === null)
        .map((row) => ({
          atRiskPaise: row.atRiskPaise,
          // Measured against the horizon rather than against now: how long a
          // request sat is a fact about the batch, and it must not grow every
          // time somebody re-reads the report.
          requestedMinutesAgo: Math.max(
            0,
            Math.round((horizonEndMs - row.requestedAt.getTime()) / 60_000),
          ),
        })),
      approvals
        .filter((row) => row.decision !== null)
        .map((row) => ({
          decision: row.decision as "approved" | "rejected",
          latencySeconds: row.latencySeconds ?? 0,
          atRiskPaise: row.atRiskPaise,
          recoveredPaise: row.case.recoveredAmountPaise,
          concessionPaise: row.concessionPaise,
        })),
    );

    return {
      total: stats.pending + stats.decisions,
      pending: stats.pending,
      decided: stats.decisions,
      approved: stats.approved,
      rejected: stats.rejected,
      medianLatencySeconds: stats.medianLatencySeconds,
      releasedValuePaise: stats.releasedValuePaise,
      recoveredAfterApprovalPaise: stats.recoveredAfterApprovalPaise,
      postApprovalRecoveryRate: stats.postApprovalRecoveryRate,
      concessionPaise: stats.concessionPaise,
    };
  }

  /**
   * Complaints TUGBOAT provoked, judged by the personas' own tolerance.
   *
   * Counted the same way the naive arm's are, over the contacts that actually
   * went out. It is not zero and should not be: a customer with a patience of
   * one is annoyed by the first message, and an agent that reports no
   * complaints has either contacted nobody or is not counting honestly.
   */
  private complaintsIn(
    personaByCaseId: Map<number, GeneratedCase>,
    cases: ReportCase[],
  ): number {
    let complaints = 0;

    for (const row of cases) {
      const generated = personaByCaseId.get(row.id);
      if (generated && row.attemptsUsed > generated.persona.complaintThreshold) complaints += 1;
    }

    return complaints;
  }
}

type ReportCase = {
  id: number;
  type: CaseType;
  stage: CaseStage;
  amountPaise: number;
  recoveredAmountPaise: number;
  rootCause: RootCause | null;
  diagnosisMethod: string | null;
  costPaise: number;
  attemptsUsed: number;
  deadlineAt: Date | null;
  lastSentiment: string | null;
  customer: { optedOutAt: Date | null };
};

type ApprovalRow = {
  caseId: number;
  gate: string;
  decision: string | null;
  latencySeconds: number | null;
  atRiskPaise: number;
  concessionPaise: number;
  requestedAt: Date;
  case: { recoveredAmountPaise: number };
};
