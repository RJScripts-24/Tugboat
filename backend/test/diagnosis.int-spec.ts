import "dotenv/config";

import { randomUUID } from "node:crypto";

import { Test } from "@nestjs/testing";

import { DetectorService } from "../src/agent-core/detector.service";
import { AppModule } from "../src/app.module";
import { FakeLlmDriver } from "../src/conversation/fake-llm.driver";
import { IngestionService } from "../src/ingestion/ingestion.service";
import type { NormalizedEvent } from "../src/ingestion/normalized-event";
import { PrismaService } from "../src/prisma/prisma.service";
import { ACTION_QUEUE } from "../src/queue/action-queue.interface";
import { InlineActionQueue } from "../src/queue/inline-action-queue";
import { purgeLedgerForCases } from "./ledger-maintenance";

/**
 * INTEGRATION SUITE — needs a real database (`npm run test:int`).
 *
 * Proves the two claims Stage 3 rests on: a rules-table diagnosis makes zero
 * model calls, and a model reply that fails the schema escalates instead of
 * being recorded as an answer.
 */
describe("Diagnosis (integration)", () => {
  const RUN = randomUUID().slice(0, 8);
  let prisma: PrismaService;
  let ingestion: IngestionService;
  let detector: DetectorService;
  let fakeLlm: FakeLlmDriver;
  let merchantId: string;

  const eventIds: string[] = [];
  /** Everything this run wrote to the detector's window, so it can be undone (B-11). */
  const startedAt = new Date();

  function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
    const eventId = `evt_${RUN}_${randomUUID().slice(0, 8)}`;
    eventIds.push(eventId);

    return {
      eventId,
      source: "razorpay",
      eventType: "payment.failed",
      occurredAt: new Date(),
      caseType: "PAYMENT_FAILED",
      amountPaise: 234_000,
      currency: "INR",
      origin: { kind: "Razorpay payment", id: `pay_${RUN}_${randomUUID().slice(0, 8)}` },
      customer: { name: `Diagnosis Customer ${RUN}`, email: `diag-${RUN}@example.test` },
      raw: { marker: RUN },
      ...overrides,
    };
  }

  async function llmCallsFor(caseId: number): Promise<number> {
    return prisma.llmCall.count({ where: { caseId } });
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
    ingestion = app.get(IngestionService);
    detector = app.get(DetectorService);
    fakeLlm = app.get(FakeLlmDriver);

    const merchant = await prisma.merchant.findFirst({ orderBy: { createdAt: "asc" } });
    if (!merchant) throw new Error("No merchant seeded — run `npm run db:seed` first.");
    merchantId = merchant.id;
  });

  afterEach(() => {
    fakeLlm.clearOverrides();
  });

  afterAll(async () => {
    const cases = await prisma.case.findMany({
      where: { customer: { name: { contains: RUN } } },
      select: { id: true },
    });
    const ids = cases.map((row) => row.id);

    await prisma.llmCall.deleteMany({ where: { caseId: { in: ids } } });
    // Ledger rows outlive their cases by design — the table refuses an
    // ordinary delete — so a suite that writes them cleans up through the
    // one maintenance hatch rather than leaving fixtures in the demo log.
    await purgeLedgerForCases(prisma, ids);
    await prisma.case.deleteMany({ where: { id: { in: ids } } });
    await prisma.customer.deleteMany({ where: { name: { contains: RUN } } });
    await prisma.webhookEvent.deleteMany({ where: { eventId: { in: eventIds } } });
    // Not only the marked probe rows: every case this suite opened wrote a
    // failure sample too, and a failure-only baseline reads as a total outage.
    await prisma.paymentSample.deleteMany({ where: { merchantId, at: { gte: startedAt } } });
    await prisma.$disconnect();
  });

  describe("the rules table", () => {
    it("diagnoses a known error code with ZERO model calls", async () => {
      const outcome = await ingestion.ingest(
        event({
          failure: {
            code: "BAD_REQUEST_ERROR",
            reason: "payment_failed_insufficient_funds",
            source: "bank",
          },
        }),
      );
      if (outcome.status !== "accepted") throw new Error("expected the case to open");

      expect(outcome.diagnosis).toMatchObject({
        rootCause: "INSUFFICIENT_FUNDS",
        method: "RULES",
        escalated: false,
      });

      // The claim the whole architecture rests on, asserted rather than assumed.
      expect(await llmCallsFor(outcome.caseId)).toBe(0);

      const record = await prisma.case.findUniqueOrThrow({ where: { id: outcome.caseId } });
      expect(record.stage).toBe("diagnosed");
      expect(record.diagnosisRuleId).toBe("R-03");
      expect(record.diagnosisConfidence).toBeGreaterThan(0.9);
    });

    it("writes the method badge the timeline renders", async () => {
      const outcome = await ingestion.ingest(
        event({ failure: { code: "BAD_REQUEST_ERROR", reason: "payment_card_expired" } }),
      );
      if (outcome.status !== "accepted") throw new Error("expected the case to open");

      const diagnosed = await prisma.caseEvent.findFirst({
        where: { caseId: outcome.caseId, kind: "DIAGNOSED" },
      });

      expect(diagnosed?.badgeLabel).toBe("method: rules-table");
      expect(diagnosed?.body).toMatchObject({ type: "diagnosis" });
    });
  });

  describe("the model path", () => {
    it("asks the model when no rule matches, and meters the call", async () => {
      const outcome = await ingestion.ingest(
        event({
          failure: { code: "SERVER_ERROR", reason: "payment_failed_unknown_reason", source: "gateway" },
        }),
      );
      if (outcome.status !== "accepted") throw new Error("expected the case to open");

      expect(outcome.diagnosis?.method).toBe("LLM");
      expect(await llmCallsFor(outcome.caseId)).toBeGreaterThan(0);

      const call = await prisma.llmCall.findFirst({ where: { caseId: outcome.caseId } });
      expect(call?.purpose).toBe("diagnosis");
      expect(call?.costPaise).toBe(0);
      expect(call?.projectedCostPaise).toBeGreaterThanOrEqual(0);
    });

    it("escalates rather than guessing when confidence is under the floor", async () => {
      fakeLlm.setOverride("diagnosis", () =>
        JSON.stringify({
          root_cause: "CARD_EXPIRED",
          confidence: 0.41,
          reasoning: "Weak signal.",
          evidence: [],
        }),
      );

      const outcome = await ingestion.ingest(
        event({ failure: { code: "SERVER_ERROR", reason: "payment_failed_unknown_reason" } }),
      );
      if (outcome.status !== "accepted") throw new Error("expected the case to open");

      expect(outcome.diagnosis?.escalated).toBe(true);

      const record = await prisma.case.findUniqueOrThrow({ where: { id: outcome.caseId } });
      expect(record.stage).toBe("escalated");
      expect(record.diagnosisConfidence).toBeCloseTo(0.41);
    });

    it("escalates when the model's reply never satisfies the schema", async () => {
      fakeLlm.setOverride("diagnosis", () => "I think the card might be expired, probably.");

      const outcome = await ingestion.ingest(
        event({ failure: { code: "SERVER_ERROR", reason: "payment_failed_unknown_reason" } }),
      );
      if (outcome.status !== "accepted") throw new Error("expected the case to open");

      const record = await prisma.case.findUniqueOrThrow({ where: { id: outcome.caseId } });

      // No diagnosis is recorded as fact — the case goes to a human instead.
      expect(record.stage).toBe("escalated");
      expect(record.rootCause).toBe("UNKNOWN");
      expect(record.diagnosisConfidence).toBe(0);

      // Both rejected attempts were still billed.
      expect(await llmCallsFor(outcome.caseId)).toBe(2);
    });
  });

  describe("the degradation detector", () => {
    it("stays quiet without enough history to judge", async () => {
      const verdict = await detector.evaluate(`${merchantId}-nonexistent`);
      expect(verdict.degraded).toBe(false);
      expect(verdict.reason).toContain("Not enough history");
    });

    it("records a failure sample for every case it opens", async () => {
      const before = await prisma.paymentSample.count({ where: { merchantId, success: false } });

      await ingestion.ingest(
        event({ failure: { code: "BAD_REQUEST_ERROR", reason: "payment_failed_insufficient_funds" } }),
      );

      const after = await prisma.paymentSample.count({ where: { merchantId, success: false } });
      expect(after).toBe(before + 1);
    });

    it("counts a success without opening a case", async () => {
      const eventId = `evt_${RUN}_ok`;
      eventIds.push(eventId);

      const cases = await prisma.case.count({ where: { merchantId } });
      const outcome = await ingestion.recordSuccess({
        eventId,
        eventType: "payment.captured",
        method: `probe-${RUN}`,
        raw: { marker: RUN },
      });

      expect(outcome.status).toBe("recorded");
      expect(await prisma.case.count({ where: { merchantId } })).toBe(cases);
      expect(
        await prisma.paymentSample.count({ where: { merchantId, method: `probe-${RUN}` } }),
      ).toBe(1);
    });
  });
});
