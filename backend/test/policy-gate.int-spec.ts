import "dotenv/config";

import { randomUUID } from "node:crypto";

import { Test } from "@nestjs/testing";
import type { Prisma } from "@prisma/client";

import { AppModule } from "../src/app.module";
import { istMinuteOfDay } from "../src/policy/ist-clock";
import { PolicyGateService } from "../src/policy/policy-gate.service";
import type { PolicyPack } from "../src/policy/policy-pack";
import { PolicyService } from "../src/policy/policy.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { ACTION_QUEUE } from "../src/queue/action-queue.interface";
import { InlineActionQueue } from "../src/queue/inline-action-queue";
import { purgeLedgerForCases } from "./ledger-maintenance";

/**
 * INTEGRATION SUITE — needs a real database (`npm run test:int`).
 *
 * Proves the claims Stage 4 rests on against real rows: every verdict is
 * persisted with the policy version that produced it, the timeline entry and
 * the decision row land together, and a pass is minted only on an allow.
 */
describe("PolicyGate (integration)", () => {
  const RUN = randomUUID().slice(0, 8);
  let prisma: PrismaService;
  let gate: PolicyGateService;
  let policy: PolicyService;
  let merchantId: string;
  let customerId: string;
  let pack: PolicyPack;
  let activeVersionId: string;

  const RUPEE = 100;
  const HOUR = 60 * 60_000;

  /** 14:30 IST — inside the contactable window. */
  const MIDDAY = new Date("2026-08-24T09:00:00.000Z");
  /** 22:30 IST — inside quiet hours. */
  const NIGHT = new Date("2026-08-24T17:00:00.000Z");

  async function openCase(
    overrides: Partial<Prisma.CaseUncheckedCreateInput> = {},
  ): Promise<number> {
    const record = await prisma.case.create({
      data: {
        merchantId,
        customerId,
        type: "PAYMENT_FAILED",
        amountPaise: 4_800 * RUPEE,
        stage: "diagnosed",
        rootCause: "INSUFFICIENT_FUNDS",
        diagnosisConfidence: 0.96,
        deadlineAt: new Date("2026-09-30T00:00:00.000Z"),
        originId: `gate_${RUN}_${randomUUID().slice(0, 8)}`,
        ...overrides,
      },
    });
    return record.id;
  }

  beforeAll(async () => {
    // The deterministic queue, deliberately. With the real one these suites
    // start a live BullMQ worker that consumes from the shared Redis queue —
    // stealing another suite's jobs and quietly working real cases mid-test
    // (B-18). Scheduling itself is proven in `queue.int-spec.ts`.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ACTION_QUEUE)
      .useValue(new InlineActionQueue())
      .compile();

    const app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    gate = app.get(PolicyGateService);
    policy = app.get(PolicyService);

    const merchant = await prisma.merchant.findFirst({ orderBy: { createdAt: "asc" } });
    if (!merchant) throw new Error("No merchant seeded — run `npm run db:seed` first.");
    merchantId = merchant.id;

    const active = await policy.getActive(merchantId);
    pack = active.pack;
    activeVersionId = active.id;

    const customer = await prisma.customer.create({
      data: { merchantId, name: `Gate Customer ${RUN}`, email: `gate-${RUN}@example.test` },
    });
    customerId = customer.id;
  });

  afterAll(async () => {
    const cases = await prisma.case.findMany({
      where: { customer: { name: { contains: RUN } } },
      select: { id: true },
    });
    const ids = cases.map((row) => row.id);

    await prisma.policyDecision.deleteMany({ where: { caseId: { in: ids } } });
    // Ledger rows outlive their cases by design — the table refuses an
    // ordinary delete — so a suite that writes them cleans up through the
    // one maintenance hatch rather than leaving fixtures in the demo log.
    await purgeLedgerForCases(prisma, ids);
    await prisma.case.deleteMany({ where: { id: { in: ids } } });
    await prisma.customer.deleteMany({ where: { name: { contains: RUN } } });
    await prisma.policyVersion.deleteMany({ where: { merchantId, createdBy: `Gate Test ${RUN}` } });
    await prisma.$disconnect();
  });

  describe("recording the verdict", () => {
    it("persists an allow, because 'bounded' is only provable if the passes are logged too", async () => {
      const caseId = await openCase();
      const result = await gate.check(caseId, { channel: "WHATSAPP", at: MIDDAY });

      expect(result.verdict).toBe("allowed");

      const row = await prisma.policyDecision.findUniqueOrThrow({ where: { id: result.decisionId } });
      expect(row.verdict).toBe("ALLOWED");
      expect(row.caseId).toBe(caseId);
      expect(row.rescheduledFor).toBeNull();
      // Which rules governed this decision is not recoverable later unless it
      // is written down now (ADR-12).
      expect(row.policyVersionId).toBe(activeVersionId);
      expect(row.checks).toHaveLength(9);
    });

    it("writes the timeline entry the Case Detail page renders", async () => {
      const caseId = await openCase();
      await gate.check(caseId, { channel: "EMAIL", at: MIDDAY });

      const event = await prisma.caseEvent.findFirstOrThrow({
        where: { caseId, kind: "POLICY_CHECK" },
        orderBy: { seq: "desc" },
      });

      expect(event.title).toBe("Policy check — 9/9 passed");
      expect(event.summary).toContain("cleared email");
      expect(event.body).toMatchObject({ type: "policy" });

      const body = event.body as { checks: { name: string }[]; rows: { label: string }[] };
      expect(body.checks.map((check) => check.name)).toContain("Opt-out");
      expect(body.rows.map((row) => row.label)).toEqual([
        "Policy version",
        "Decision",
        "Evaluated in",
      ]);
    });

    it("keeps the decision row and the timeline entry in step", async () => {
      const caseId = await openCase();
      await gate.check(caseId, { channel: "WHATSAPP", at: MIDDAY });
      await gate.check(caseId, { channel: "EMAIL", at: NIGHT });

      const [decisions, events] = await Promise.all([
        prisma.policyDecision.count({ where: { caseId } }),
        prisma.caseEvent.count({ where: { caseId, kind: "POLICY_CHECK" } }),
      ]);

      expect(decisions).toBe(2);
      expect(events).toBe(2);
    });
  });

  describe("the pass", () => {
    it("is minted on an allow and carries the version that cleared it", async () => {
      const caseId = await openCase();
      const result = await gate.check(caseId, { channel: "WHATSAPP", at: MIDDAY });

      expect(result.pass).not.toBeNull();
      expect(result.pass).toMatchObject({
        caseId,
        channel: "WHATSAPP",
        decisionId: result.decisionId,
        policyVersion: result.policyVersion,
      });
    });

    it.each([
      ["a block", { channel: "WHATSAPP" as const, at: NIGHT }],
      ["an approval", { channel: "WHATSAPP" as const, at: MIDDAY, concessionPaise: 480 * RUPEE, discountPercent: 10 }],
    ])("is withheld on %s, so no adapter can be called", async (_label, action) => {
      const caseId = await openCase();
      const result = await gate.check(caseId, action);

      expect(result.verdict).not.toBe("allowed");
      expect(result.pass).toBeNull();
    });
  });

  describe("blocks that defer rather than destroy", () => {
    it("returns the reschedule time for a quiet-hours block and stores it", async () => {
      const caseId = await openCase();
      const result = await gate.check(caseId, { channel: "WHATSAPP", at: NIGHT });

      expect(result.verdict).toBe("blocked");
      expect(result.rescheduledFor).not.toBeNull();
      expect(istMinuteOfDay(result.rescheduledFor as Date)).toBe(pack.quiet.endMinutes);

      const row = await prisma.policyDecision.findUniqueOrThrow({ where: { id: result.decisionId } });
      expect(row.rescheduledFor?.getTime()).toBe(result.rescheduledFor?.getTime());
    });

    it("exempts a silent retry from the same window", async () => {
      const caseId = await openCase();
      const result = await gate.check(caseId, { channel: "RETRY", at: NIGHT });

      expect(result.verdict).toBe("allowed");
      expect(result.rescheduledFor).toBeNull();
    });
  });

  describe("reading the case's real state", () => {
    it("halts every channel for a customer who opted out", async () => {
      const optedOut = await prisma.customer.create({
        data: {
          merchantId,
          name: `Gate OptOut ${RUN}`,
          email: `optout-${RUN}@example.test`,
          optedOutAt: new Date(),
        },
      });
      const caseId = await openCase({ customerId: optedOut.id });

      const result = await gate.check(caseId, { channel: "WHATSAPP", at: MIDDAY });

      expect(result.verdict).toBe("blocked");
      expect(result.terminalStage).toBe("halted");
      expect(result.pass).toBeNull();
    });

    it("counts only executed actions against a bound", async () => {
      const caseId = await openCase();

      // Planned and blocked work never reached anybody, so it must not spend
      // the case's rope.
      await prisma.action.create({
        data: {
          caseId,
          kind: "VOICE",
          channel: "VOICE",
          status: "BLOCKED",
          idempotencyKey: `gate_${RUN}_blocked_${randomUUID().slice(0, 8)}`,
        },
      });

      const first = await gate.check(caseId, { channel: "VOICE", at: MIDDAY });
      expect(first.verdict).toBe("allowed");

      await prisma.action.create({
        data: {
          caseId,
          kind: "VOICE",
          channel: "VOICE",
          status: "EXECUTED",
          executedAt: new Date(MIDDAY.getTime() - 30 * HOUR),
          idempotencyKey: `gate_${RUN}_executed_${randomUUID().slice(0, 8)}`,
        },
      });

      const second = await gate.check(caseId, { channel: "VOICE", at: MIDDAY });
      expect(second.verdict).toBe("blocked");
      expect(second.terminalStage).toBeNull();
    });

    it("escalates a low-confidence diagnosis to the approvals queue", async () => {
      const caseId = await openCase({ diagnosisConfidence: 0.41, stage: "escalated" });
      const result = await gate.check(caseId, { channel: "WHATSAPP", at: MIDDAY });

      expect(result.verdict).toBe("needs_approval");
      expect(result.gate).toBe("confidence_below_threshold");

      const row = await prisma.policyDecision.findUniqueOrThrow({ where: { id: result.decisionId } });
      expect(row.verdict).toBe("NEEDS_APPROVAL");
    });
  });

  describe("the versioned write path", () => {
    it("cuts a version, deactivates the old one, and chains the history", async () => {
      const before = await policy.getActive(merchantId);
      const next = structuredClone(before.pack);
      next.contact.channelCaps.EMAIL = before.pack.contact.channelCaps.EMAIL === 2 ? 3 : 2;

      const saved = await policy.save(merchantId, next, `Gate Test ${RUN}`);

      expect(saved.unchanged).toBe(false);
      expect(saved.changes).toHaveLength(1);

      const active = await policy.getActive(merchantId);
      expect(active.version).toBe(saved.version);

      const actives = await prisma.policyVersion.count({ where: { merchantId, isActive: true } });
      expect(actives).toBe(1);

      const revisions = await policy.revisions(merchantId);
      expect(revisions[0].version).toBe(saved.version);
      expect(revisions[0].prevHash).toBe(revisions[1].hash);

      // Restore the seeded pack so the demo data stays as the seed left it.
      await prisma.policyVersion.deleteMany({
        where: { merchantId, createdBy: `Gate Test ${RUN}` },
      });
      await prisma.policyVersion.updateMany({
        where: { merchantId, version: before.version },
        data: { isActive: true },
      });
    });

    it("refuses to switch opt-out off", async () => {
      const active = await policy.getActive(merchantId);
      const disabled = { ...active.pack, rules: { ...active.pack.rules, opt_out: false } };

      await expect(policy.save(merchantId, disabled, `Gate Test ${RUN}`)).rejects.toMatchObject({
        status: 422,
      });

      expect((await policy.getActive(merchantId)).version).toBe(active.version);
    });
  });
});
