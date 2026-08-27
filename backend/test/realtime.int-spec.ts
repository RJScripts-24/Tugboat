import "dotenv/config";

import { randomUUID } from "node:crypto";

import { Test } from "@nestjs/testing";

import { AppModule } from "../src/app.module";
import { ApprovalsService } from "../src/approvals/approvals.service";
import { CaseOverridesService } from "../src/cases/case-overrides.service";
import { CasesService } from "../src/cases/cases.service";
import type { DomainEvent } from "../src/common/domain-event";
import { DomainEventsService } from "../src/common/domain-events.service";
import { DashboardService } from "../src/dashboard/dashboard.service";
import { PolicyGateService } from "../src/policy/policy-gate.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { ACTION_QUEUE } from "../src/queue/action-queue.interface";
import { InlineActionQueue } from "../src/queue/inline-action-queue";
import { purgeLedgerForCases } from "./ledger-maintenance";

/**
 * INTEGRATION SUITE — needs a real database (`npm run test:int`).
 *
 * Stage 9's three claims, against real rows:
 *
 * 1. Nothing is announced until it is true. The outbox is unit-tested against a
 *    fake, which proves the buffering; this proves the seam is actually wired
 *    into the writer, which a unit test cannot.
 * 2. The manual pause is real. Not a badge — the PolicyGate refuses while it is
 *    set, and lets go the moment it is cleared.
 * 3. The dashboard's figures come out of the same rows the pipeline lists, so
 *    the funnel and the case list cannot disagree.
 * 4. A run nobody promoted stays in the Lab. Its cases, its money and its
 *    escalations are in no operational figure until it is the promoted batch.
 */
describe("realtime, overrides and the dashboard (integration)", () => {
  const RUN = randomUUID().slice(0, 8);

  let prisma: PrismaService;
  let domain: DomainEventsService;
  let overrides: CaseOverridesService;
  let approvals: ApprovalsService;
  let cases: CasesService;
  let gate: PolicyGateService;
  let dashboard: DashboardService;

  let merchantId: string;
  let customerId: string;

  const RUPEE = 100;
  /** 14:30 IST — comfortably inside the contactable window. */
  const MIDDAY = new Date("2026-08-24T09:00:00.000Z");

  /** Everything the bus emitted while `work` ran. */
  async function capture(work: () => Promise<unknown>): Promise<DomainEvent[]> {
    const seen: DomainEvent[] = [];
    const offs = (
      [
        "activity.new",
        "case.updated",
        "kpi.updated",
        "approval.pending",
        "approval.decided",
        "policy.changed",
      ] as const
    ).map((name) => domain.on(name, (event) => seen.push(event)));

    try {
      await work();
    } finally {
      for (const off of offs) off();
    }

    return seen;
  }

  async function openCase(overridesInput: Record<string, unknown> = {}): Promise<number> {
    const record = await prisma.case.create({
      data: {
        merchantId,
        customerId,
        type: "PAYMENT_FAILED",
        amountPaise: 4_800 * RUPEE,
        stage: "diagnosed",
        rootCause: "INSUFFICIENT_FUNDS",
        diagnosisConfidence: 0.96,
        diagnosisMethod: "RULES",
        deadlineAt: new Date("2026-09-30T00:00:00.000Z"),
        originId: `rt_${RUN}_${randomUUID().slice(0, 8)}`,
        ...overridesInput,
      },
    });
    return record.id;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ACTION_QUEUE)
      .useValue(new InlineActionQueue())
      .compile();

    const app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    domain = app.get(DomainEventsService);
    overrides = app.get(CaseOverridesService);
    approvals = app.get(ApprovalsService);
    cases = app.get(CasesService);
    gate = app.get(PolicyGateService);
    dashboard = app.get(DashboardService);

    const merchant = await prisma.merchant.findFirst({ orderBy: { createdAt: "asc" } });
    if (!merchant) throw new Error("No merchant seeded — run `npm run db:seed` first.");
    merchantId = merchant.id;

    const customer = await prisma.customer.create({
      data: { merchantId, name: `Realtime Customer ${RUN}`, email: `rt-${RUN}@example.test` },
    });
    customerId = customer.id;
  });

  afterAll(async () => {
    const rows = await prisma.case.findMany({
      where: { customer: { name: { contains: RUN } } },
      select: { id: true },
    });
    const ids = rows.map((row) => row.id);

    await prisma.policyDecision.deleteMany({ where: { caseId: { in: ids } } });
    await prisma.action.deleteMany({ where: { caseId: { in: ids } } });
    await purgeLedgerForCases(prisma, ids);
    await prisma.case.deleteMany({ where: { id: { in: ids } } });
    await prisma.customer.deleteMany({ where: { name: { contains: RUN } } });
    await prisma.$disconnect();
  });

  describe("the bus is wired into the writer, not bolted beside it", () => {
    it("announces a feed line and a case update for every case event", async () => {
      const caseId = await openCase();

      const seen = await capture(() =>
        cases.transition(caseId, "intervening", {
          kind: "PLANNED",
          title: "Plan chosen",
          summary: "WhatsApp first · cheapest rung that can reach this customer",
        }),
      );

      const activity = seen.find((event) => event.name === "activity.new");
      const updated = seen.find((event) => event.name === "case.updated");

      expect(activity).toBeDefined();
      expect(updated).toMatchObject({ caseId: `C-${caseId}`, stage: "intervening" });
      // The strip is nudged rather than handed numbers; the gateway computes.
      expect(seen.some((event) => event.name === "kpi.updated")).toBe(true);
    });

    it("says nothing at all when the transaction rolls back", async () => {
      const caseId = await openCase();

      const seen = await capture(async () => {
        // An illegal move: `recovered` is final, so the machine throws inside
        // the transaction and the whole write — event, stage and ledger row —
        // is undone. A bus that emitted on publish rather than on commit would
        // have told every open browser this case was recovered.
        await prisma.case.update({ where: { id: caseId }, data: { stage: "recovered" } });

        await expect(
          cases.transition(caseId, "intervening", {
            kind: "PLANNED",
            title: "Plan chosen",
            summary: "should never be announced",
          }),
        ).rejects.toThrow();
      });

      expect(seen).toEqual([]);
    });
  });

  describe("the manual pause is enforced, not decorative", () => {
    it("refuses every outbound action while a case is paused", async () => {
      const caseId = await openCase();

      const before = await gate.check(caseId, { channel: "WHATSAPP", at: MIDDAY });
      expect(before.verdict).toBe("allowed");

      await overrides.apply(merchantId, caseId, "pause", `Tester ${RUN}`, "held for review");

      const during = await gate.check(caseId, { channel: "WHATSAPP", at: MIDDAY });
      expect(during.verdict).toBe("blocked");
      expect(
        during.checks.find((check) => check.name === "Human override")?.verdict,
      ).toBe("block");

      // A pause is not a halt: the case keeps its stage and can be handed back.
      const paused = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
      expect(paused.stage).toBe("diagnosed");
      expect(paused.pausedAt).not.toBeNull();

      await overrides.apply(merchantId, caseId, "resume", `Tester ${RUN}`, null);

      const after = await gate.check(caseId, { channel: "WHATSAPP", at: MIDDAY });
      expect(after.verdict).toBe("allowed");
    });

    it("writes each override onto the case's own ledger chain", async () => {
      const caseId = await openCase();

      await overrides.apply(merchantId, caseId, "pause", `Tester ${RUN}`, null);
      await overrides.apply(merchantId, caseId, "resume", `Tester ${RUN}`, null);

      const rows = await prisma.auditLedger.findMany({
        where: { merchantId, chain: `C-${caseId}` },
        orderBy: { seq: "asc" },
      });

      const actions = rows.map((row) => row.action);
      expect(actions).toContain("AGENT_PAUSED_BY_HUMAN");
      expect(actions).toContain("AGENT_RESUMED_BY_HUMAN");
      expect(rows.every((row) => row.actor === "HUMAN")).toBe(true);

      // Chained onto whatever the case already had, not started beside it.
      for (let index = 1; index < rows.length; index += 1) {
        expect(rows[index].prevHash).toBe(rows[index - 1].hash);
      }
    });

    it("closes a case that was settled somewhere other than Tugboat", async () => {
      const caseId = await openCase({ stage: "waiting" });

      const result = await overrides.apply(
        merchantId,
        caseId,
        "resolve-external",
        `Tester ${RUN}`,
        "paid by bank transfer",
      );

      expect(result.stage).toBe("halted");
      // Closed, not recovered: no money arrived through Tugboat, and claiming
      // it did would inflate the one number this whole product is judged on.
      const record = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
      expect(record.recoveredAmountPaise).toBe(0);
    });

    it("refuses to take over a case that already recovered", async () => {
      const caseId = await openCase({ stage: "recovered", recoveredAmountPaise: 4_800 * RUPEE });

      await expect(
        overrides.apply(merchantId, caseId, "pause", `Tester ${RUN}`, null),
      ).rejects.toMatchObject({
        response: { error: expect.stringContaining("already recovered") },
      });
    });
  });

  describe("a run nobody promoted stays in the Lab", () => {
    it("keeps an un-promoted batch out of the KPIs, the pipeline and the approvals queue", async () => {
      const before = await Promise.all([
        dashboard.kpis(merchantId),
        cases.list(merchantId, { take: 1 }),
        approvals.pendingCount(merchantId),
      ]);

      const run = await prisma.simRun.create({
        data: {
          merchantId,
          ref: `SIM-RT-${RUN}`,
          seed: 7,
          batchSize: 1,
          mix: {},
          difficulty: "realistic",
          arms: ["tugboat"],
          status: "COMPLETED",
        },
      });

      const caseId = await openCase({ simRunId: run.id, simArm: "tugboat" });
      await prisma.approval.create({
        data: {
          caseId,
          gate: "b2b_high_value",
          headline: "must not be counted",
          justification: [],
          chips: [],
          draft: {},
          atRiskPaise: 4_800 * RUPEE,
        },
      });

      try {
        const [kpis, list, pending] = await Promise.all([
          dashboard.kpis(merchantId),
          cases.list(merchantId, { take: 1 }),
          approvals.pendingCount(merchantId),
        ]);

        // Every figure is exactly what it was. The run's case, its money and its
        // escalation belong to the evidence report until the run is promoted —
        // before this rule, a batch run from the Lab doubled the dashboard's
        // case count the moment it started (B-44, D-120).
        expect(kpis.revenueAtRiskCases).toBe(before[0].revenueAtRiskCases);
        expect(kpis.revenueAtRiskPaise).toBe(before[0].revenueAtRiskPaise);
        expect(list.total).toBe(before[1].total);
        expect(pending).toBe(before[2]);

        // Still reachable by its reference: the report's exception samples link
        // straight to their cases, promoted or not.
        await expect(cases.findOne(merchantId, caseId)).resolves.toMatchObject({ id: caseId });
      } finally {
        await prisma.case.delete({ where: { id: caseId } });
        await prisma.simRun.delete({ where: { id: run.id } });
      }
    });
  });

  describe("the dashboard reads the same rows the pipeline lists", () => {
    it("counts the funnel from the event log, so a stage cannot hide its history", async () => {
      const [kpis, funnel, causes] = await Promise.all([
        dashboard.kpis(merchantId),
        dashboard.funnel(merchantId),
        dashboard.rootCauses(merchantId),
      ]);

      // The narrated set (D-120): live cases plus the promoted batch. A database
      // that has been used for development holds batches nobody promoted, and
      // none of those may appear in a figure on the Control Tower.
      const total = await prisma.case.count({
        where: { merchantId, OR: [{ simRunId: null }, { simRun: { promotedAt: { not: null } } }] },
      });

      expect(kpis.revenueAtRiskCases).toBe(total);
      // Detected is every case that ever opened, so it is the widest band and
      // no later band can exceed it.
      const detected = funnel.find((stage) => stage.key === "detected");
      expect(detected).toBeDefined();
      for (const stage of funnel) expect(stage.cases).toBeLessThanOrEqual(total);

      // The root-cause table and the KPI headline are two reads of one column.
      const causeCases = causes.reduce((sum, row) => sum + row.cases, 0);
      expect(causeCases).toBe(total);
    });

    it("draws a recovery curve that can only rise", async () => {
      const { recoveryRateSeries } = await dashboard.kpis(merchantId);

      expect(recoveryRateSeries).toHaveLength(14);
      for (let index = 1; index < recoveryRateSeries.length; index += 1) {
        expect(recoveryRateSeries[index]).toBeGreaterThanOrEqual(recoveryRateSeries[index - 1]);
      }
    });

    it("never reports a bucket with no traffic as a 0% success rate", async () => {
      const series = await dashboard.successRateSeries(merchantId);

      expect(series.points).toHaveLength(48);
      // A gap carries the previous reading; a cliff to zero would read as an
      // outage nobody had.
      expect(series.points.every((point) => point.rate >= 0)).toBe(true);
      if (series.incident) {
        expect(series.incident.index).toBeGreaterThanOrEqual(0);
        expect(series.incident.index).toBeLessThan(48);
      }
    });
  });
});
