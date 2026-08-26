import "dotenv/config";

import { randomUUID } from "node:crypto";

import { Test } from "@nestjs/testing";
import type { Prisma } from "@prisma/client";

import { AgentWorker } from "../src/agent-core/agent-worker";
import { ExecutorService } from "../src/agent-core/executor.service";
import { AppModule } from "../src/app.module";
import { InboundService } from "../src/conversation/inbound.service";
import { IngestionService } from "../src/ingestion/ingestion.service";
import type { NormalizedEvent } from "../src/ingestion/normalized-event";
import { PrismaService } from "../src/prisma/prisma.service";
import { ACTION_QUEUE } from "../src/queue/action-queue.interface";
import { InlineActionQueue } from "../src/queue/inline-action-queue";
import { purgeLedgerForCases } from "./ledger-maintenance";

/**
 * INTEGRATION SUITE — needs a real database (`npm run test:int`).
 *
 * The Stage 5 Definition of Done, asserted end to end: a case arrives, is
 * diagnosed, planned, gated and acted on entirely through queued jobs; a
 * killed-and-restarted worker does not double-send; and a promise creates its
 * row and its follow-up.
 *
 * The queue is the deterministic one so a three-day mandate spacing can be
 * drained in a millisecond. BullMQ over the real Redis is proven separately in
 * `queue.int-spec.ts`.
 */
describe("The agent loop (integration)", () => {
  const RUN = randomUUID().slice(0, 8);
  const HOUR = 60 * 60_000;
  const DAY = 24 * HOUR;

  let prisma: PrismaService;
  let ingestion: IngestionService;
  let executor: ExecutorService;
  let worker: AgentWorker;
  let inbound: InboundService;
  let queue: InlineActionQueue;
  let merchantId: string;

  const eventIds: string[] = [];
  const startedAt = new Date();

  /**
   * Contact details unique to this run.
   *
   * `resolveCustomer` matches an incoming event to an existing customer by
   * email or phone, which is correct — an opt-out is permanent and belongs to
   * the person, not the case. It also means a fixed test phone number binds new
   * cases to whatever an earlier run left behind, opt-out included (B-20).
   */
  const digits = RUN.replace(/\D/g, "").padEnd(6, "7").slice(0, 6);
  const PHONE = `+9198${digits}00`;
  const ALT_PHONE = `+9197${digits}11`;

  function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
    const eventId = `evt_${RUN}_${randomUUID().slice(0, 8)}`;
    eventIds.push(eventId);

    return {
      eventId,
      source: "simulator",
      eventType: "payment.failed",
      occurredAt: new Date(),
      caseType: "PAYMENT_FAILED",
      amountPaise: 480_000,
      currency: "INR",
      origin: { kind: "Razorpay payment", id: `pay_${RUN}_${randomUUID().slice(0, 8)}` },
      customer: {
        name: `Loop Customer ${RUN}`,
        email: `loop-${RUN}@example.test`,
        phone: PHONE,
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

  async function openCase(overrides: Partial<Prisma.CaseUncheckedCreateInput> = {}): Promise<number> {
    const customer = await prisma.customer.create({
      data: {
        merchantId,
        name: `Loop Direct ${RUN}`,
        email: `direct-${RUN}-${randomUUID().slice(0, 6)}@example.test`,
        phone: ALT_PHONE,
        maskedPhone: `${ALT_PHONE.slice(0, 8)}•••11`,
        maskedEmail: "d•••t@example.test",
      },
    });

    const record = await prisma.case.create({
      data: {
        merchantId,
        customerId: customer.id,
        type: "PAYMENT_FAILED",
        amountPaise: 480_000,
        stage: "diagnosed",
        rootCause: "INSUFFICIENT_FUNDS",
        diagnosisConfidence: 0.96,
        originId: `direct_${RUN}_${randomUUID().slice(0, 8)}`,
        ...overrides,
      },
    });

    return record.id;
  }

  async function timeline(caseId: number): Promise<string[]> {
    const events = await prisma.caseEvent.findMany({
      where: { caseId },
      orderBy: { seq: "asc" },
      select: { kind: true },
    });
    return events.map((entry) => entry.kind);
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ACTION_QUEUE)
      .useValue(new InlineActionQueue())
      .compile();

    const app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    ingestion = app.get(IngestionService);
    executor = app.get(ExecutorService);
    worker = app.get(AgentWorker);
    inbound = app.get(InboundService);
    queue = app.get(ACTION_QUEUE);

    const merchant = await prisma.merchant.findFirst({ orderBy: { createdAt: "asc" } });
    if (!merchant) throw new Error("No merchant seeded — run `npm run db:seed` first.");
    merchantId = merchant.id;
  });

  afterAll(async () => {
    const cases = await prisma.case.findMany({
      where: { customer: { name: { contains: RUN } } },
      select: { id: true },
    });
    const ids = cases.map((row) => row.id);

    // Ledger rows outlive their cases by design — the table refuses an
    // ordinary delete — so a suite that writes them cleans up through the
    // one maintenance hatch rather than leaving fixtures in the demo log.
    await purgeLedgerForCases(prisma, ids);
    await prisma.paymentPromise.deleteMany({ where: { caseId: { in: ids } } });
    await prisma.policyDecision.deleteMany({ where: { caseId: { in: ids } } });
    await prisma.llmCall.deleteMany({ where: { caseId: { in: ids } } });
    await prisma.case.deleteMany({ where: { id: { in: ids } } });
    await prisma.customer.deleteMany({ where: { name: { contains: RUN } } });
    await prisma.webhookEvent.deleteMany({ where: { eventId: { in: eventIds } } });
    await prisma.paymentSample.deleteMany({ where: { merchantId, at: { gte: startedAt } } });
    await prisma.$disconnect();
  });

  describe("case in, contact out, entirely on the queue", () => {
    it("queues the first step rather than sending inside the webhook", async () => {
      const outcome = await ingestion.ingest(event());
      if (outcome.status !== "accepted") throw new Error("expected the case to open");

      // Nothing has been sent: the webhook answered as soon as the case existed.
      expect(await prisma.action.count({ where: { caseId: outcome.caseId } })).toBe(0);
      expect(queue.pending().some((job) => job.caseId === outcome.caseId)).toBe(true);
      expect(await timeline(outcome.caseId)).toEqual(["DETECTED", "DIAGNOSED"]);
    });

    it("plans, gates and sends when the job runs", async () => {
      const outcome = await ingestion.ingest(event());
      if (outcome.status !== "accepted") throw new Error("expected the case to open");

      await queue.drain();

      expect(await timeline(outcome.caseId)).toEqual([
        "DETECTED",
        "DIAGNOSED",
        "PLANNED",
        "POLICY_CHECK",
        "WHATSAPP_SENT",
      ]);

      const action = await prisma.action.findFirstOrThrow({ where: { caseId: outcome.caseId } });
      expect(action.status).toBe("EXECUTED");
      expect(action.channel).toBe("WHATSAPP");
      expect(action.channelRef).toMatch(/^SM[0-9a-f]{12}$/);
      expect(action.costPaise).toBeGreaterThan(0);

      const record = await prisma.case.findUniqueOrThrow({ where: { id: outcome.caseId } });
      expect(record.stage).toBe("waiting");
      expect(record.attemptsUsed).toBe(1);
      expect(record.costPaise).toBe(action.costPaise);
    });

    it("quotes the real message on the timeline, opt-out line included", async () => {
      const outcome = await ingestion.ingest(event());
      if (outcome.status !== "accepted") throw new Error("expected the case to open");

      await queue.drain();

      const sent = await prisma.caseEvent.findFirstOrThrow({
        where: { caseId: outcome.caseId, kind: "WHATSAPP_SENT" },
      });
      const body = sent.body as { type: string; lines: string[]; rows: { value: string }[] };

      expect(body.type).toBe("message");
      expect(body.lines.at(-1)).toBe("Reply STOP if you'd rather not hear from us.");
      // Every simulated send says so where the UI shows it (Rule 5).
      expect(body.rows.some((row) => row.value.includes("Simulated"))).toBe(true);
    });

    it("schedules the next rung behind the cool-down instead of sending twice", async () => {
      const caseId = await openCase();
      await executor.step(caseId);

      const next = queue.pending().filter((job) => job.caseId === caseId);
      expect(next).toHaveLength(1);
      expect(queue.dueAt(next[0].jobId)! - Date.now()).toBeGreaterThan(19 * HOUR);
    });
  });

  describe("a killed worker does not double-send", () => {
    it("skips a redelivered job rather than spending the next attempt", async () => {
      const caseId = await openCase();

      const first = await executor.step(caseId, { expectAttempt: 0 });
      expect(first.kind).toBe("sent");

      // A worker died after sending and the broker redelivered the same job.
      // Without the attempt guard this plans the *next* rung and contacts the
      // customer a second time (B-15).
      const replay = await executor.step(caseId, { expectAttempt: 0 });
      expect(replay.kind).toBe("skipped");

      const actions = await prisma.action.findMany({ where: { caseId } });
      expect(actions).toHaveLength(1);
      expect(actions[0].status).toBe("EXECUTED");
      expect(actions[0].channel).toBe("WHATSAPP");
    });

    it("skips a duplicate even when two workers race on the same rung", async () => {
      const caseId = await openCase();

      // Both believe the case is at attempt 0. The unique index on the action
      // key is what decides which of them actually sends.
      const [a, b] = await Promise.all([
        executor.step(caseId, { expectAttempt: 0 }),
        executor.step(caseId, { expectAttempt: 0 }),
      ]);

      const kinds = [a.kind, b.kind].sort();
      expect(kinds).toEqual(["sent", "skipped"]);
      expect(await prisma.action.count({ where: { caseId, status: "EXECUTED" } })).toBe(1);
    });

    it("claims the row before the send, so a crash mid-flight is visible", async () => {
      const caseId = await openCase();
      await executor.step(caseId);

      const action = await prisma.action.findFirstOrThrow({ where: { caseId } });
      // The unique key is what makes the replay above a no-op.
      expect(action.idempotencyKey).toBe(`case:${caseId}:WHATSAPP:1`);
    });

    it("survives the same job being delivered three times", async () => {
      const caseId = await openCase();
      const job = {
        kind: "case.step" as const,
        caseId,
        jobId: `case:${caseId}:step:0`,
        reason: "redelivery test",
        expectAttempt: 0,
      };

      await worker.handle(job);
      await worker.handle(job);
      await worker.handle(job);

      expect(await prisma.action.count({ where: { caseId, status: "EXECUTED" } })).toBe(1);
      expect((await prisma.case.findUniqueOrThrow({ where: { id: caseId } })).attemptsUsed).toBe(1);
    });
  });

  describe("the customer answers", () => {
    it("halts every channel on an opt-out and cancels the scheduled work", async () => {
      const caseId = await openCase();
      await executor.step(caseId);
      expect(queue.pending().some((job) => job.caseId === caseId)).toBe(true);

      const outcome = await inbound.handle({ caseId, channel: "WHATSAPP", text: "STOP" });

      expect(outcome.matchedKeyword).toBe("STOP");
      expect(outcome.consequence).toBe("halted");

      const record = await prisma.case.findUniqueOrThrow({
        where: { id: caseId },
        include: { customer: true },
      });
      expect(record.stage).toBe("halted");
      expect(record.customer.optedOutAt).not.toBeNull();

      // A halt that leaves a nudge in the queue is a delay, not a halt.
      expect(queue.pending().some((job) => job.caseId === caseId)).toBe(false);
    });

    it("refuses to act again even if a step is somehow replayed after an opt-out", async () => {
      const caseId = await openCase();
      await inbound.handle({ caseId, channel: "WHATSAPP", text: "STOP" });

      const outcome = await executor.step(caseId);
      expect(outcome.kind).toBe("skipped");
      expect(await prisma.action.count({ where: { caseId, status: "EXECUTED" } })).toBe(0);
    });

    it("escalates hardship rather than halting it — that is a different fact", async () => {
      const caseId = await openCase();
      await executor.step(caseId);

      const outcome = await inbound.handle({
        caseId,
        channel: "WHATSAPP",
        text: "Money is very tight this month, I cannot afford it right now",
      });

      expect(outcome.hardship).toBe(true);
      expect(outcome.consequence).toBe("escalated");

      const record = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
      expect(record.stage).toBe("escalated");
      expect(record.hardshipFlaggedAt).not.toBeNull();
    });

    it("lets a neutral reply carry on inside the bounds", async () => {
      const caseId = await openCase();
      await executor.step(caseId);

      const outcome = await inbound.handle({ caseId, channel: "WHATSAPP", text: "ok" });

      expect(outcome.consequence).toBe("continues");
      expect((await prisma.case.findUniqueOrThrow({ where: { id: caseId } })).stage).toBe("waiting");
    });

    it("records a late reply on a closed case without trying to move it", async () => {
      const caseId = await openCase();
      await inbound.handle({ caseId, channel: "WHATSAPP", text: "STOP" });
      expect((await prisma.case.findUniqueOrThrow({ where: { id: caseId } })).stage).toBe("halted");

      // The customer answers again the next morning. Replies arrive
      // asynchronously and a case can close in between (B-19).
      const late = await inbound.handle({
        caseId,
        channel: "WHATSAPP",
        text: "Money is very tight, I cannot afford it",
      });

      expect(late.consequence).toBe("escalated");
      // Recorded, not acted on: there is no stage left to move to.
      expect((await prisma.case.findUniqueOrThrow({ where: { id: caseId } })).stage).toBe("halted");
      expect((await timeline(caseId)).filter((kind) => kind === "CUSTOMER_REPLY")).toHaveLength(2);
    });

    it("records the reply on the timeline with its consequence", async () => {
      const caseId = await openCase();
      await executor.step(caseId);
      await inbound.handle({ caseId, channel: "WHATSAPP", text: "STOP" });

      const reply = await prisma.caseEvent.findFirstOrThrow({
        where: { caseId, kind: "CUSTOMER_REPLY" },
      });
      const body = reply.body as { sentiment: string; rows: { label: string; value: string }[] };

      // The wire spelling, not the Prisma identifier.
      expect(body.sentiment).toBe("opt-out");
      expect(body.rows.find((row) => row.label === "Classified by")?.value).toContain("no model call");
    });
  });

  describe("the voice call and its promise", () => {
    it("records a promise, its row, and the follow-up job", async () => {
      // Two attempts spent puts the INSUFFICIENT_FUNDS ladder on its voice rung.
      const caseId = await openCase({ attemptsUsed: 2 });

      const outcome = await executor.step(caseId, { counterpart: "promise" });
      expect(outcome.kind).toBe("sent");

      const record = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
      expect(record.stage).toBe("promised");

      const promise = await prisma.paymentPromise.findFirstOrThrow({ where: { caseId } });
      expect(promise.status).toBe("PENDING");
      expect(promise.promisedAmountPaise).toBe(record.amountPaise);
      expect(promise.followUpJobId).toBe(`promise:${promise.id}`);

      expect(await timeline(caseId)).toContain("PROMISE_RECORDED");

      const scheduled = queue.pending().find((job) => job.jobId === `promise:${promise.id}`);
      expect(scheduled).toBeDefined();
      expect(queue.dueAt(scheduled!.jobId)! - Date.now()).toBeGreaterThan(2 * DAY);
    });

    it("escalates a broken promise instead of nudging again", async () => {
      const caseId = await openCase({ attemptsUsed: 2 });
      await executor.step(caseId, { counterpart: "promise" });

      const promise = await prisma.paymentPromise.findFirstOrThrow({ where: { caseId } });

      // Isolate this case: other tests left cool-down steps in the shared queue
      // that would also come due four days out.
      for (const job of queue.pending()) {
        if (job.jobId !== `promise:${promise.id}`) await queue.cancel(job.jobId);
      }

      // The promised date arrives on the simulated clock, not in real time.
      await queue.drain(Date.now() + 4 * DAY);

      const after = await prisma.paymentPromise.findUniqueOrThrow({ where: { id: promise.id } });
      expect(after.status).toBe("BROKEN");

      const record = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
      expect(record.stage).toBe("escalated");
      expect(await timeline(caseId)).toContain("ESCALATED");
    });

    it("stands down when the call surfaces hardship", async () => {
      const caseId = await openCase({ attemptsUsed: 2 });

      const outcome = await executor.step(caseId, { counterpart: "decline" });
      expect(outcome.kind).toBe("escalated");

      const record = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
      expect(record.stage).toBe("escalated");
      expect(record.hardshipFlaggedAt).not.toBeNull();

      const call = await prisma.caseEvent.findFirstOrThrow({
        where: { caseId, kind: "VOICE_CALL" },
      });
      const body = call.body as { intent: string; transcript: unknown[] };
      expect(body.intent).toBe("HARDSHIP_DECLARED");
      expect(body.transcript.length).toBeGreaterThan(2);
    });

    it("carries on down the ladder when nobody picks up", async () => {
      const caseId = await openCase({ attemptsUsed: 2 });

      const outcome = await executor.step(caseId, { counterpart: "no-answer" });
      expect(outcome.kind).toBe("sent");

      const record = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
      expect(record.stage).toBe("waiting");
      expect(record.attemptsUsed).toBe(3);
    });
  });

  describe("the gate still governs every step", () => {
    it("defers a night-time nudge and reschedules it rather than dropping it", async () => {
      const caseId = await openCase();

      // 22:30 IST. The gate defers; the case keeps its contact.
      jest.useFakeTimers({ now: new Date("2026-08-24T17:00:00.000Z"), advanceTimers: true });
      try {
        const outcome = await executor.step(caseId);
        expect(outcome.kind).toBe("deferred");
      } finally {
        jest.useRealTimers();
      }

      const record = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
      expect(record.stage).toBe("waiting");
      expect(record.attemptsUsed).toBe(0);
      expect(await prisma.action.count({ where: { caseId } })).toBe(0);
      expect(await timeline(caseId)).toEqual(["PLANNED", "POLICY_CHECK"]);
    });

    it("closes a case whose attempts are spent, with the reason on the timeline", async () => {
      const caseId = await openCase({ attemptsUsed: 4 });

      const outcome = await executor.step(caseId);
      expect(outcome.kind).toBe("closed");

      const record = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
      expect(record.stage).toBe("exhausted");

      const halted = await prisma.caseEvent.findFirstOrThrow({
        where: { caseId, kind: "HALTED" },
      });
      expect(halted.title).toBe("Case exhausted");
      expect(halted.summary).toContain("Attempt cap reached");
    });

    it("writes a policy decision for every step, including the ones it allowed", async () => {
      const caseId = await openCase();
      await executor.step(caseId);

      const decisions = await prisma.policyDecision.findMany({ where: { caseId } });
      expect(decisions).toHaveLength(1);
      expect(decisions[0].verdict).toBe("ALLOWED");
    });
  });
});
