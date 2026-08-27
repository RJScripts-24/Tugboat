import "dotenv/config";

import { Test } from "@nestjs/testing";
import type { CaseType } from "@prisma/client";

import { AppModule } from "../src/app.module";
import { ComplianceService } from "../src/metrics/compliance.service";
import type { SimulationReport } from "../src/metrics/report.service";
import { PolicyService } from "../src/policy/policy.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { SimulationsService } from "../src/simulator/simulations.service";
import { purgeLedgerForCases } from "./ledger-maintenance";

/**
 * INTEGRATION SUITE — needs a real database (`npm run test:int`).
 *
 * The Stage 8 Definition of Done, asserted end to end on a small batch: the
 * same seed twice produces the same report, the recovery rate lands in a
 * believable band and nowhere near certainty, the exceptions list is non-empty
 * and reasoned, and — the load-bearing one — the "zero violations" lines are
 * computed from the ledger and the action rows rather than from the agent's own
 * account of itself. That last claim is proved the only way it can be: by
 * planting a violation and watching the report find it.
 *
 * The batch is deliberately small. What is being tested here is the machinery
 * and the arithmetic, both of which are size-independent; the shipped seed-42
 * batch is produced by the same code path and committed as an artifact.
 */
describe("The simulator, evaluator and evidence report (integration)", () => {
  const BATCH = 14;
  const RUN_TIMEOUT_MS = 15 * 60_000;

  const MIX: Record<CaseType, number> = {
    PAYMENT_FAILED: 40,
    CHECKOUT_ABANDONED: 25,
    MANDATE_FAILED: 20,
    INVOICE_OVERDUE: 15,
  };

  let app: Awaited<ReturnType<typeof buildApp>>;
  let prisma: PrismaService;
  let simulations: SimulationsService;
  let compliance: ComplianceService;
  let policy: PolicyService;
  let merchantId: string;

  const runIds: string[] = [];

  async function buildApp() {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const instance = moduleRef.createNestApplication();
    await instance.init();
    return instance;
  }

  /** Starts a run and waits for it, rather than polling a fixed number of times. */
  async function runToCompletion(seed: number): Promise<SimulationReport> {
    const run = await simulations.create(merchantId, {
      batchSize: BATCH,
      mix: MIX,
      difficulty: "realistic",
      seed,
      arms: ["baseline", "naive", "tugboat"],
    });
    runIds.push(run.id);

    const deadline = Date.now() + RUN_TIMEOUT_MS;
    for (;;) {
      const status = await simulations.status(merchantId, run.ref);
      if (status.status === "COMPLETED") break;
      if (status.status === "FAILED") throw new Error(`Run failed: ${status.failureReason}`);
      if (Date.now() > deadline) throw new Error(`Run did not finish inside ${RUN_TIMEOUT_MS}ms`);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }

    return simulations.reportFor(merchantId, run.ref);
  }

  /**
   * The report with its database identities removed.
   *
   * Case references are assigned by an autoincrement that has no memory of the
   * previous run, so they necessarily differ. Everything that is a
   * *measurement* must not.
   */
  function measurementsOf(report: SimulationReport) {
    return {
      ...report,
      run: { ...report.run, id: "<ref>" },
      exceptions: report.exceptions.map((group) => ({
        ...group,
        sample: group.sample.map(({ id: _id, ...rest }) => rest),
      })),
    };
  }

  beforeAll(async () => {
    app = await buildApp();
    prisma = app.get(PrismaService);
    simulations = app.get(SimulationsService);
    compliance = app.get(ComplianceService);
    policy = app.get(PolicyService);

    const merchant = await prisma.merchant.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
    merchantId = merchant.id;
  }, 120_000);

  afterAll(async () => {
    // The ledger is append-only at the database level; the seeded bypass is the
    // one way a test can clean up after itself (D-76).
    for (const runId of runIds) {
      const cases = await prisma.case.findMany({ where: { simRunId: runId }, select: { id: true } });
      await purgeLedgerForCases(
        prisma,
        cases.map((row) => row.id),
      );
      await prisma.case.deleteMany({ where: { simRunId: runId } });
      await prisma.paymentSample.deleteMany({ where: { simRunId: runId } });
      await prisma.simRun.delete({ where: { id: runId } }).catch(() => undefined);
    }

    await app.close();
  }, 120_000);

  describe("a completed run", () => {
    let report: SimulationReport;

    beforeAll(async () => {
      report = await runToCompletion(4242);
    }, RUN_TIMEOUT_MS + 60_000);

    it("produces the whole report, including the unflattering half", () => {
      expect(report.schema).toBe("tugboat.simulation.report/1");
      expect(report.run.batchSize).toBe(BATCH);
      expect(report.run.armsExecuted).toEqual(["tugboat"]);
      expect(report.headline.cases).toBe(BATCH);
      expect(report.arms.map((arm) => arm.key)).toEqual(["baseline", "naive", "tugboat"]);
      expect(report.diagnosis.total).toBe(BATCH);
      expect(report.stoppingRules.length).toBeGreaterThan(5);
      expect(report.compliance.assertions).toHaveLength(4);
    });

    it("has customers replying to the messages the agent sent", async () => {
      // The whole persona engine hangs off this. Since the tick clock was
      // frozen (B-35) every send carried the tick's exact instant and the
      // collector's strict lower bound excluded all of them, so for a while
      // no customer replied to anything and nobody noticed — recoveries still
      // arrived from silent retries and the unflattering numbers looked
      // plausible (B-48). This is the assertion that would have caught it.
      const replies = await prisma.caseEvent.count({
        where: { kind: "CUSTOMER_REPLY", case: { simRunId: runIds[0] } },
      });
      expect(replies).toBeGreaterThan(0);

      const sends = await prisma.action.count({
        where: { status: "EXECUTED", channel: { not: "RETRY" }, case: { simRunId: runIds[0] } },
      });
      // Not every message gets an answer, but a batch where none does is broken.
      expect(replies).toBeGreaterThan(sends * 0.05);
    });

    it("recovers a believable share, and nothing like all of it", () => {
      const rate = report.headline.recoveryRate;

      expect(rate).toBeGreaterThan(0);
      // The number a panelist should disbelieve is a high one. A bounded agent
      // working a population where two in three never answer does not recover
      // most of the money, and a batch that claimed to would be evidence the
      // simulator was broken rather than that the agent was good.
      expect(rate).toBeLessThan(0.8);
    });

    it("beats the counterfactual it is measured against", () => {
      const [baseline, naive, tugboat] = report.arms;

      expect(tugboat.recoveredPaise).toBeGreaterThan(baseline.recoveredPaise);
      expect(report.headline.upliftPoints).toBeGreaterThan(0);
      // The argument for bounds is not the money — it is this column.
      expect(naive.contacts).toBeGreaterThan(tugboat.contacts);
      expect(naive.quietHourSends).toBeGreaterThan(0);
      expect(tugboat.quietHourSends).toBe(0);
    });

    it("lists its exceptions, each with a reason and each case counted once", () => {
      expect(report.exceptions.length).toBeGreaterThan(0);

      const total = report.exceptions.reduce((sum, group) => sum + group.cases, 0);
      expect(total).toBe(BATCH - report.headline.recoveredCases);

      for (const group of report.exceptions) {
        expect(group.note.length).toBeGreaterThan(20);
        expect(group.cases).toBeGreaterThan(0);
        expect(group.sample.length).toBeGreaterThan(0);
      }
    });

    it("attributes every closed case to exactly one stopping rule", () => {
      const endings = report.stoppingRules
        .filter((rule) => rule.terminal)
        .reduce((sum, rule) => sum + rule.fired, 0);

      const closed = report.exceptions
        .filter((group) => ["opt_out", "sentiment", "exhausted"].includes(group.key))
        .reduce((sum, group) => sum + group.cases, 0);

      expect(endings).toBeLessThanOrEqual(BATCH);
      expect(endings).toBeGreaterThanOrEqual(closed - report.exceptions.length);
    });

    it("keeps the ground truth out of the agent's reach and inside the grade", async () => {
      const truth = await prisma.simGroundTruth.count({
        where: { simRunId: runIds[0] },
      });

      expect(truth).toBe(BATCH);
      expect(report.diagnosis.graded).toBeGreaterThan(0);
      // A grade of exactly 1.0 over a batch containing deliberately misleading
      // error codes would mean the agent had seen the answer key.
      expect(report.diagnosis.accuracy).toBeLessThan(1);
    });

    it("prices the run from the actions it actually took", () => {
      expect(report.cost.channelPaise).toBeGreaterThan(0);
      expect(report.cost.llmCalls).toBeGreaterThan(0);
      expect(report.compliance.entries).toBeGreaterThan(BATCH);
    });
  });

  describe("the compliance lines are ledger-derived, not self-reported", () => {
    it("finds a violation that is planted after the fact", async () => {
      const runId = runIds[0];
      const cases = await prisma.case.findMany({
        where: { simRunId: runId },
        select: { id: true },
      });
      const caseIds = cases.map((row) => row.id);
      const { pack } = await policy.getActive(merchantId);

      const clean = await compliance.assess(merchantId, caseIds, pack);
      expect(clean.counts.quietHourSends).toBe(0);
      expect(clean.block.assertions[0].held).toBe(true);

      // 23:10 IST — squarely inside the window the agent is not allowed to send
      // in. Written straight to the actions table, exactly as a bug in the gate
      // would have written it.
      const planted = await prisma.action.create({
        data: {
          caseId: caseIds[0],
          kind: "WHATSAPP",
          channel: "WHATSAPP",
          status: "EXECUTED",
          attempt: 9,
          idempotencyKey: `planted:${runId}:quiet-hours`,
          executedAt: new Date(Date.UTC(2026, 7, 12, 17, 40)),
        },
      });

      const found = await compliance.assess(merchantId, caseIds, pack);

      expect(found.counts.quietHourSends).toBe(1);
      expect(found.block.assertions[0].held).toBe(false);
      expect(found.block.assertions[0].claim).toContain("1 messages sent inside quiet hours");

      await prisma.action.delete({ where: { id: planted.id } });

      const restored = await compliance.assess(merchantId, caseIds, pack);
      expect(restored.block.assertions[0].held).toBe(true);
    }, 120_000);

    it("finds a contact sent after an opt-out", async () => {
      const runId = runIds[0];
      const record = await prisma.case.findFirstOrThrow({
        where: { simRunId: runId },
        select: { id: true, customerId: true },
      });
      const { pack } = await policy.getActive(merchantId);

      const optedOutAt = new Date(Date.UTC(2026, 7, 12, 6, 0));
      await prisma.customer.update({
        where: { id: record.customerId },
        data: { optedOutAt },
      });

      const planted = await prisma.action.create({
        data: {
          caseId: record.id,
          kind: "EMAIL",
          channel: "EMAIL",
          status: "EXECUTED",
          attempt: 9,
          idempotencyKey: `planted:${runId}:post-opt-out`,
          // Inside business hours, so only the opt-out assertion can catch it.
          executedAt: new Date(Date.UTC(2026, 7, 12, 8, 30)),
        },
      });

      const found = await compliance.assess(
        merchantId,
        [record.id],
        pack,
      );

      expect(found.counts.contactsAfterOptOut).toBe(1);
      expect(found.block.assertions[1].held).toBe(false);

      await prisma.action.delete({ where: { id: planted.id } });
      await prisma.customer.update({
        where: { id: record.customerId },
        data: { optedOutAt: null },
      });
    }, 120_000);
  });

  describe("reproducibility", () => {
    it("produces the same measurements from the same seed, twice", async () => {
      const first = await runToCompletion(9001);
      const second = await runToCompletion(9001);

      // Case references differ — they are database identities, not
      // measurements. Everything else, down to the confusion pairs and the
      // paise, must be identical.
      expect(measurementsOf(second)).toEqual(measurementsOf(first));
    }, 2 * RUN_TIMEOUT_MS + 60_000);
  });
});
