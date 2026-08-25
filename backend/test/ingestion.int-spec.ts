import "dotenv/config";

import { randomUUID } from "node:crypto";

import { Test } from "@nestjs/testing";

import { AppModule } from "../src/app.module";
import { CasesService } from "../src/cases/cases.service";
import { IngestionService } from "../src/ingestion/ingestion.service";
import type { NormalizedEvent } from "../src/ingestion/normalized-event";
import { PrismaService } from "../src/prisma/prisma.service";
import { ACTION_QUEUE } from "../src/queue/action-queue.interface";
import { InlineActionQueue } from "../src/queue/inline-action-queue";

/**
 * INTEGRATION SUITE — needs a real database (`npm run test:int`).
 *
 * De-duplication is a property of a unique constraint and a transaction, so
 * proving it against a fake would only prove the fake. Everything created here
 * is tagged with a per-run marker and deleted afterwards, so it never disturbs
 * the seeded demo data.
 */
describe("Ingestion (integration)", () => {
  const RUN = randomUUID().slice(0, 8);
  let prisma: PrismaService;
  let ingestion: IngestionService;
  let cases: CasesService;
  let merchantId: string;

  const createdEventIds: string[] = [];

  function paymentFailed(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
    const eventId = overrides.eventId ?? `evt_${RUN}_${randomUUID().slice(0, 8)}`;
    createdEventIds.push(eventId);

    return {
      eventId,
      source: "razorpay",
      eventType: "payment.failed",
      occurredAt: new Date(),
      caseType: "PAYMENT_FAILED",
      amountPaise: 234_000,
      currency: "INR",
      origin: { kind: "Razorpay payment", id: `pay_${RUN}_${randomUUID().slice(0, 8)}` },
      customer: {
        name: `Integration Customer ${RUN}`,
        email: `int-${RUN}@example.test`,
        phone: `99${RUN.replace(/\D/g, "").padEnd(8, "0").slice(0, 8)}`,
      },
      failure: {
        code: "BAD_REQUEST_ERROR",
        reason: "payment_failed_insufficient_funds",
        source: "bank",
      },
      raw: { marker: RUN },
      ...overrides,
    };
  }

  /** Everything this run wrote to the detector's window, so it can be undone. */
  const startedAt = new Date();

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
    cases = app.get(CasesService);

    const merchant = await prisma.merchant.findFirst({ orderBy: { createdAt: "asc" } });
    if (!merchant) throw new Error("No merchant seeded — run `npm run db:seed` first.");
    merchantId = merchant.id;
  });

  afterAll(async () => {
    await prisma.case.deleteMany({ where: { customer: { name: { contains: RUN } } } });
    await prisma.customer.deleteMany({ where: { name: { contains: RUN } } });
    await prisma.webhookEvent.deleteMany({ where: { eventId: { in: createdEventIds } } });
    // Every opened case writes a failed payment sample. Left behind, they are a
    // failure-only baseline that reads to the detector as a permanent outage
    // (B-11), so the run takes its own samples with it.
    await prisma.paymentSample.deleteMany({ where: { merchantId, at: { gte: startedAt } } });
    await prisma.$disconnect();
  });

  it("opens exactly one case for a payment-failed event", async () => {
    const event = paymentFailed();
    const outcome = await ingestion.ingest(event);

    expect(outcome.status).toBe("accepted");

    const opened = await prisma.case.findMany({ where: { originId: event.origin.id } });
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      type: "PAYMENT_FAILED",
      amountPaise: 234_000,
      // Ingestion runs detect -> diagnose, so a case with a mapped error code
      // has already moved past `detected` by the time this returns (Stage 3).
      stage: "diagnosed",
      rootCause: "INSUFFICIENT_FUNDS",
    });
  });

  it("opens exactly one case when the SAME event is delivered twice", async () => {
    const event = paymentFailed();

    const first = await ingestion.ingest(event);
    const second = await ingestion.ingest(event);

    expect(first.status).toBe("accepted");
    expect(second.status).toBe("duplicate");

    const opened = await prisma.case.findMany({ where: { originId: event.origin.id } });
    expect(opened).toHaveLength(1);
  });

  it("opens exactly one case when both deliveries arrive at once", async () => {
    const event = paymentFailed();

    const outcomes = await Promise.all([ingestion.ingest(event), ingestion.ingest(event)]);
    const statuses = outcomes.map((outcome) => outcome.status).sort();

    expect(statuses).toEqual(["accepted", "duplicate"]);
    expect(await prisma.case.count({ where: { originId: event.origin.id } })).toBe(1);
  });

  it("does not open a second case for a different event on the same origin", async () => {
    const origin = { kind: "Razorpay payment", id: `pay_${RUN}_shared` };

    await ingestion.ingest(paymentFailed({ origin }));
    const second = await ingestion.ingest(paymentFailed({ origin }));

    expect(second.status).toBe("accepted");
    expect(await prisma.case.count({ where: { originId: origin.id } })).toBe(1);
  });

  it("writes the detection event as the first entry in the case's history", async () => {
    const event = paymentFailed();
    const outcome = await ingestion.ingest(event);
    if (outcome.status !== "accepted") throw new Error("expected the case to open");

    const events = await prisma.caseEvent.findMany({
      where: { caseId: outcome.caseId },
      orderBy: { seq: "asc" },
    });

    expect(events[0]).toMatchObject({ seq: 1, kind: "DETECTED", title: "Payment failed" });
    expect(events[0].summary).toContain("payment_failed_insufficient_funds");
  });

  it("keeps the event log gapless and ordered across a transition", async () => {
    const event = paymentFailed();
    const outcome = await ingestion.ingest(event);
    if (outcome.status !== "accepted") throw new Error("expected the case to open");

    await cases.transition(outcome.caseId, "intervening", {
      kind: "PLANNED",
      title: "Planned — silent retry",
      summary: "attempt 1 of 4",
    });

    const events = await prisma.caseEvent.findMany({
      where: { caseId: outcome.caseId },
      orderBy: { seq: "asc" },
    });

    expect(events.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(events.map((entry) => entry.kind)).toEqual(["DETECTED", "DIAGNOSED", "PLANNED"]);

    const updated = await prisma.case.findUniqueOrThrow({ where: { id: outcome.caseId } });
    expect(updated.stage).toBe("intervening");
    expect(updated.rootCause).toBe("INSUFFICIENT_FUNDS");
  });

  it("refuses an illegal transition and leaves the case untouched", async () => {
    const event = paymentFailed();
    const outcome = await ingestion.ingest(event);
    if (outcome.status !== "accepted") throw new Error("expected the case to open");

    const before = await prisma.caseEvent.count({ where: { caseId: outcome.caseId } });

    await expect(
      cases.transition(outcome.caseId, "recovered", {
        kind: "RECOVERED",
        title: "Recovered",
        summary: "should never be written",
      }),
    ).rejects.toThrow(/diagnosed -> recovered/);

    const after = await prisma.case.findUniqueOrThrow({ where: { id: outcome.caseId } });
    expect(after.stage).toBe("diagnosed");

    // The rollback matters as much as the rejection: a rejected transition must
    // not leave an event describing something that did not happen.
    expect(await prisma.caseEvent.count({ where: { caseId: outcome.caseId } })).toBe(before);
  });

  it("acknowledges an event type no playbook opens, without creating a case", async () => {
    const eventId = `evt_${RUN}_ignored`;
    createdEventIds.push(eventId);

    const before = await prisma.case.count({ where: { merchantId } });
    const outcome = await ingestion.acknowledgeUnhandled(eventId, "razorpay", "payment.captured", {
      marker: RUN,
    });

    expect(outcome.status).toBe("ignored");
    expect(await prisma.case.count({ where: { merchantId } })).toBe(before);

    const stored = await prisma.webhookEvent.findUnique({ where: { eventId } });
    expect(stored?.processedAt).not.toBeNull();
  });
});
