import "dotenv/config";

import { randomUUID } from "node:crypto";

import { Test } from "@nestjs/testing";
import type { ApprovalGate, Prisma } from "@prisma/client";

import { AgentWorker } from "../src/agent-core/agent-worker";
import { ExecutorService } from "../src/agent-core/executor.service";
import { AppModule } from "../src/app.module";
import { CasesService } from "../src/cases/cases.service";
import { ApprovalsService } from "../src/approvals/approvals.service";
import { OPT_OUT_LINE } from "../src/channels/message-copy";
import { InboundService } from "../src/conversation/inbound.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { ACTION_QUEUE } from "../src/queue/action-queue.interface";
import { InlineActionQueue } from "../src/queue/inline-action-queue";
import { purgeLedgerForCases } from "./ledger-maintenance";

/**
 * INTEGRATION SUITE — needs a real database (`npm run test:int`).
 *
 * The Stage 6 Definition of Done, asserted end to end: an escalation raises a
 * request carrying the exact message that was stopped; approve → the gate runs
 * again and the case resumes; reject → the agent stands down; and both replay
 * on the case's own timeline in the order they happened.
 *
 * The queue is the deterministic one so a release can be drained in the same
 * millisecond it is queued.
 */
describe("Approvals (integration)", () => {
  const RUN = randomUUID().slice(0, 8);
  const RUPEE = 100;

  let prisma: PrismaService;
  let approvals: ApprovalsService;
  let executor: ExecutorService;
  let cases: CasesService;
  let queue: InlineActionQueue;
  let inbound: InboundService;
  let merchantId: string;
  let merchantName: string;

  const startedAt = new Date();

  /**
   * A fresh customer per case.
   *
   * `resolveCustomer` matches on email or phone, so reused contact details bind
   * new cases to whatever an earlier run left behind — opt-out included (B-20).
   */
  async function openCase(
    overrides: Partial<Prisma.CaseUncheckedCreateInput> = {},
    customerOverrides: Partial<Prisma.CustomerUncheckedCreateInput> = {},
  ): Promise<number> {
    const tag = randomUUID().slice(0, 6);

    const customer = await prisma.customer.create({
      data: {
        merchantId,
        name: `Approvals ${RUN} ${tag}`,
        email: `ap-${RUN}-${tag}@example.test`,
        phone: `+9196${RUN.replace(/\D/g, "").padEnd(6, "4").slice(0, 6)}${tag.slice(0, 2).replace(/\D/g, "0")}`,
        maskedEmail: `a•••••@example.test`,
        maskedPhone: "96•••••210",
        ...customerOverrides,
      },
    });

    const record = await prisma.case.create({
      data: {
        merchantId,
        customerId: customer.id,
        type: "PAYMENT_FAILED",
        amountPaise: 4_800 * RUPEE,
        stage: "diagnosed",
        rootCause: "INSUFFICIENT_FUNDS",
        diagnosisConfidence: 0.94,
        originId: `pay_${RUN}_${tag}`,
        ...overrides,
      },
    });

    return record.id;
  }

  /** A case sitting on the gate that will actually refuse it. */
  async function escalatedCase(
    gate: ApprovalGate,
  ): Promise<{ caseId: number; approvalId: string }> {
    const caseId =
      gate === "b2b_high_value"
        ? await openCase(
            { amountPaise: 42_000 * RUPEE, type: "INVOICE_OVERDUE" },
            { segment: "B2B" },
          )
        : gate === "confidence_below_threshold"
          ? await openCase({ diagnosisConfidence: 0.41, rootCause: "UNKNOWN" })
          : gate === "hardship_language"
            ? await openCase({ hardshipFlaggedAt: new Date(), lastSentimentScore: -0.74 })
            : await openCase();

    if (gate === "discount_requires_approval") {
      // No playbook rung proposes a concession yet (D-71), so this gate is
      // reached by handing the case over the way the Executor does — the
      // transition first, then the request — rather than through `step`.
      await cases.transition(caseId, "escalated", {
        kind: "ESCALATED",
        title: "Escalated to a human",
        summary: "A concession was requested, and Boa may not give money away",
        body: { type: "facts", rows: [{ label: "Gate", value: gate, mono: true }] },
      });

      const approval = await approvals.raise({ caseId, gate, channel: "WHATSAPP" });
      return { caseId, approvalId: approval.id };
    }

    const outcome = await executor.step(caseId);
    expect(outcome.kind).toBe("escalated");

    const approval = await prisma.approval.findFirstOrThrow({ where: { caseId } });
    return { caseId, approvalId: approval.id };
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
    // Registers the queue handler, which is what makes a drained release run.
    app.get(AgentWorker);

    prisma = app.get(PrismaService);
    approvals = app.get(ApprovalsService);
    executor = app.get(ExecutorService);
    cases = app.get(CasesService);
    inbound = app.get(InboundService);
    queue = app.get(ACTION_QUEUE);

    const merchant = await prisma.merchant.findFirst({ orderBy: { createdAt: "asc" } });
    if (!merchant) throw new Error("No merchant seeded — run `npm run db:seed` first.");
    merchantId = merchant.id;
    merchantName = merchant.displayName;
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
    await prisma.approval.deleteMany({ where: { caseId: { in: ids } } });
    await prisma.paymentPromise.deleteMany({ where: { caseId: { in: ids } } });
    await prisma.policyDecision.deleteMany({ where: { caseId: { in: ids } } });
    await prisma.llmCall.deleteMany({ where: { caseId: { in: ids } } });
    await prisma.case.deleteMany({ where: { id: { in: ids } } });
    await prisma.customer.deleteMany({ where: { name: { contains: RUN } } });
    await prisma.paymentSample.deleteMany({ where: { merchantId, at: { gte: startedAt } } });
    await prisma.$disconnect();
  });

  /* ---------------------------------------------------------------- */

  describe("a gate that refuses raises a card a human can answer", () => {
    it("stops the case and writes the request in one pass", async () => {
      const { caseId, approvalId } = await escalatedCase("b2b_high_value");

      const record = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
      expect(record.stage).toBe("escalated");
      // Nothing was sent: the point of the gate is that it stopped first.
      expect(await prisma.action.count({ where: { caseId, status: "EXECUTED" } })).toBe(0);

      const approval = await prisma.approval.findUniqueOrThrow({ where: { id: approvalId } });
      expect(approval.gate).toBe("b2b_high_value");
      expect(approval.decision).toBeNull();
      expect(approval.atRiskPaise).toBe(42_000 * RUPEE);
      expect(approval.headline).toContain("₹42,000");
    });

    it("holds the blocked action as a real row, not an implied one", async () => {
      const { caseId } = await escalatedCase("b2b_high_value");

      const action = await prisma.action.findFirstOrThrow({ where: { caseId } });
      expect(action.status).toBe("NEEDS_APPROVAL");
      expect(action.idempotencyKey).toContain(":approval:b2b_high_value:");
      expect(action.executedAt).toBeNull();
    });

    it("carries the exact message that would have gone out", async () => {
      const { approvalId } = await escalatedCase("discount_requires_approval");

      const approval = await prisma.approval.findUniqueOrThrow({ where: { id: approvalId } });
      const draft = approval.draft as unknown as { channel: string; lines: string[]; to: string };

      expect(draft.channel).toBe("WHATSAPP");
      expect(draft.lines.at(-1)).toBe(OPT_OUT_LINE);
      // The card is the most screen-shared surface in the product.
      expect(draft.to).toBe("96•••••210");
    });

    it("raises one card when the same escalation is replayed", async () => {
      const { caseId } = await escalatedCase("confidence_below_threshold");

      // A redelivered step re-runs the gate and escalates again.
      await executor.step(caseId);
      await executor.step(caseId);

      expect(await prisma.approval.count({ where: { caseId } })).toBe(1);
    });

    it("leaves a re-escalated case escalated rather than mid-intervention", async () => {
      // A step plans before it gates, which moves an escalated case back to
      // `intervening`. The escalation that follows used to read the stage it
      // had loaded before that move and take the append-only branch, leaving a
      // case that is waiting on a human looking like one being worked (B-23).
      const { caseId } = await escalatedCase("confidence_below_threshold");
      await executor.step(caseId);

      const record = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
      expect(record.stage).toBe("escalated");
    });

    it("does not raise a card for an escalation no merchant can answer", async () => {
      const caseId = await openCase();
      const promise = await prisma.paymentPromise.create({
        data: {
          caseId,
          promisedAmountPaise: 4_800 * RUPEE,
          promisedDate: new Date(Date.now() - 86_400_000),
        },
      });

      // A broken promise is operational: the case goes to a person on the
      // pipeline, but there is no gate question to put on a card (D-69).
      const outcome = await executor.checkPromise(promise.id);
      expect(outcome.kind).toBe("escalated");

      expect(await prisma.approval.count({ where: { caseId } })).toBe(0);
      expect((await timeline(caseId)).at(-1)).toBe("ESCALATED");
    });
  });

  /* ---------------------------------------------------------------- */

  describe("approve → the gate runs again, then the case resumes", () => {
    it("records the decision, releases the send, and reopens the case", async () => {
      const { caseId, approvalId } = await escalatedCase("b2b_high_value");

      const { approval } = await approvals.approve(merchantId, approvalId, { by: merchantName });
      expect(approval.decision).toBe("approved");
      expect(approval.latencySeconds).toBeGreaterThanOrEqual(1);

      // Approving is a permission, not a send: nothing has left yet.
      expect(await prisma.action.count({ where: { caseId, status: "EXECUTED" } })).toBe(0);

      await queue.drain();

      const record = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
      expect(record.stage).toBe("waiting");
      expect(record.attemptsUsed).toBe(1);

      const action = await prisma.action.findFirstOrThrow({ where: { caseId } });
      expect(action.status).toBe("EXECUTED");
      expect(action.channelRef).toMatch(/^re_[0-9a-f]{14}$/);
    });

    it("replays on the case timeline in the order it happened", async () => {
      const { caseId, approvalId } = await escalatedCase("b2b_high_value");
      await approvals.approve(merchantId, approvalId, { by: merchantName });
      await queue.drain();

      expect(await timeline(caseId)).toEqual([
        "PLANNED",
        "POLICY_CHECK",
        "ESCALATED",
        "APPROVAL_DECIDED",
        "POLICY_CHECK",
        "EMAIL_SENT",
      ]);
    });

    it("names the human and the response time on the timeline entry", async () => {
      const { caseId, approvalId } = await escalatedCase("b2b_high_value");
      await approvals.approve(merchantId, approvalId, { by: merchantName });

      const decided = await prisma.caseEvent.findFirstOrThrow({
        where: { caseId, kind: "APPROVAL_DECIDED" },
      });
      const body = decided.body as { rows: { label: string; value: string }[] };

      expect(decided.title).toBe(`Approved by ${merchantName}`);
      expect(body.rows.find((row) => row.label === "Decided by")?.value).toBe(merchantName);
      expect(body.rows.find((row) => row.label === "Response time")?.value).toMatch(/^\d+s$/);
      expect(body.rows.find((row) => row.label === "Audited as")?.value).toContain("HUMAN");
    });

    it("writes a second policy check — the approved action is checked again", async () => {
      const { caseId, approvalId } = await escalatedCase("b2b_high_value");
      await approvals.approve(merchantId, approvalId, { by: merchantName });
      await queue.drain();

      const decisions = await prisma.policyDecision.findMany({
        where: { caseId },
        orderBy: { evaluatedAt: "asc" },
      });

      expect(decisions.map((row) => row.verdict)).toEqual(["NEEDS_APPROVAL", "ALLOWED"]);

      const cleared = decisions[1].checks as unknown as { name: string; note: string }[];
      const gate = cleared.find((check) => check.name === "Escalation gate");
      expect(gate?.note).toContain(merchantName);
    });

    it("sends the approver's edit, not the copy it was derived from", async () => {
      const { caseId, approvalId } = await escalatedCase("discount_requires_approval");

      await approvals.approve(merchantId, approvalId, {
        by: merchantName,
        draftLines: [
          "Hi Ananya — one-off, we can do 12% off.",
          "Grab it here: rzp.io/l/tug-abc123",
          OPT_OUT_LINE,
        ],
      });
      await queue.drain();

      const sent = await prisma.caseEvent.findFirstOrThrow({
        where: { caseId, kind: "WHATSAPP_SENT" },
      });
      const body = sent.body as { lines: string[] };

      expect(body.lines[0]).toBe("Hi Ananya — one-off, we can do 12% off.");
    });

    it("restores an opt-out line the approver deleted rather than refusing the edit", async () => {
      const { caseId, approvalId } = await escalatedCase("discount_requires_approval");

      const { draftEdited } = await approvals.approve(merchantId, approvalId, {
        by: merchantName,
        draftLines: ["Hi Ananya — 12% off, one time.", "rzp.io/l/tug-abc123"],
      });
      await queue.drain();

      expect(draftEdited).toBe(true);

      const sent = await prisma.caseEvent.findFirstOrThrow({
        where: { caseId, kind: "WHATSAPP_SENT" },
      });
      expect((sent.body as { lines: string[] }).lines.at(-1)).toBe(OPT_OUT_LINE);

      const decided = await prisma.caseEvent.findFirstOrThrow({
        where: { caseId, kind: "APPROVAL_DECIDED" },
      });
      const rows = (decided.body as { rows: { label: string; value: string }[] }).rows;
      expect(rows.find((row) => row.label === "Draft")?.value).toContain(
        "opt-out line was restored",
      );
    });

    it("sends a stand-down once and closes the case", async () => {
      const { caseId, approvalId } = await escalatedCase("hardship_language");
      await approvals.approve(merchantId, approvalId, { by: merchantName });
      await queue.drain();

      const record = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
      expect(record.stage).toBe("halted");
      expect(await timeline(caseId)).toContain("HALTED");

      // Closed means closed: no follow-up was booked.
      expect(queue.pending().filter((job) => job.caseId === caseId)).toHaveLength(0);
    });

    it("refuses a second decision on a request already answered", async () => {
      const { approvalId } = await escalatedCase("b2b_high_value");
      await approvals.approve(merchantId, approvalId, { by: merchantName });

      await expect(
        approvals.reject(merchantId, approvalId, { by: merchantName, reason: "Changed my mind" }),
      ).rejects.toThrow(/already approved/);
    });

    it("does not send twice when the release job is redelivered", async () => {
      const { caseId, approvalId } = await escalatedCase("b2b_high_value");
      await approvals.approve(merchantId, approvalId, { by: merchantName });

      const first = await executor.releaseApproved(approvalId);
      const replay = await executor.releaseApproved(approvalId);

      expect(first.kind).toBe("sent");
      expect(replay.kind).toBe("skipped");
      expect(await prisma.action.count({ where: { caseId, status: "EXECUTED" } })).toBe(1);
    });
  });

  /* ---------------------------------------------------------------- */

  describe("an approval does not override the bounds that protect a person", () => {
    it("halts instead of sending when the customer opted out after approving", async () => {
      const { caseId, approvalId } = await escalatedCase("b2b_high_value");
      await approvals.approve(merchantId, approvalId, { by: merchantName });

      // An opt-out belongs to the person, not to the case that heard it (B-20),
      // so it can arrive on another case entirely between the click and the
      // release. The gate is what has to notice.
      const record = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
      await prisma.customer.update({
        where: { id: record.customerId },
        data: { optedOutAt: new Date() },
      });

      const outcome = await executor.releaseApproved(approvalId);
      expect(outcome.kind).toBe("closed");

      const after = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
      expect(after.stage).toBe("halted");
      expect(await prisma.action.count({ where: { caseId, status: "EXECUTED" } })).toBe(0);
    });

    it("does not release onto a case that closed while the request was waiting", async () => {
      const { caseId, approvalId } = await escalatedCase("b2b_high_value");
      await approvals.approve(merchantId, approvalId, { by: merchantName });

      await inbound.handle({ caseId, text: "STOP", channel: "EMAIL" });

      const outcome = await executor.releaseApproved(approvalId);
      expect(outcome.kind).toBe("skipped");
      expect(await prisma.action.count({ where: { caseId, status: "EXECUTED" } })).toBe(0);
    });
  });

  /* ---------------------------------------------------------------- */

  describe("reject → the agent stands down", () => {
    it("closes the case and records the reason a merchant gave", async () => {
      const { caseId, approvalId } = await escalatedCase("b2b_high_value");

      const decided = await approvals.reject(merchantId, approvalId, {
        by: merchantName,
        reason: "Sales owns this account — they will handle it",
      });

      expect(decided.decision).toBe("rejected");
      expect(decided.reason).toBe("Sales owns this account — they will handle it");

      const record = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
      expect(record.stage).toBe("halted");
      expect(record.attemptsUsed).toBe(0);

      expect(await timeline(caseId)).toEqual([
        "PLANNED",
        "POLICY_CHECK",
        "ESCALATED",
        "APPROVAL_DECIDED",
        "HALTED",
      ]);
    });

    it("leaves no scheduled work behind on a case a human closed", async () => {
      const { caseId, approvalId } = await escalatedCase("confidence_below_threshold");
      await approvals.reject(merchantId, approvalId, {
        by: merchantName,
        reason: "Route to manual review rather than another automated attempt",
      });

      expect(queue.pending().filter((job) => job.caseId === caseId)).toHaveLength(0);

      // And a drain does not resurrect it.
      await queue.drain();
      const record = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
      expect(record.stage).toBe("halted");
    });

    it("marks the blocked action refused rather than leaving it pending forever", async () => {
      const { caseId, approvalId } = await escalatedCase("b2b_high_value");
      await approvals.reject(merchantId, approvalId, {
        by: merchantName,
        reason: "Payment is already scheduled · do not chase",
      });

      const action = await prisma.action.findFirstOrThrow({ where: { caseId } });
      expect(action.status).toBe("BLOCKED");
      expect(action.failureReason).toContain(merchantName);
    });

    it("carries on with the standard playbook when only a concession was refused", async () => {
      const { caseId, approvalId } = await escalatedCase("discount_requires_approval");

      await approvals.reject(merchantId, approvalId, {
        by: merchantName,
        reason: "Margin is already thin on this line — no discount",
      });
      await queue.drain();

      const record = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
      // The case is alive and was worked without the discount.
      expect(record.stage).toBe("waiting");
      expect(record.attemptsUsed).toBe(1);
      expect(await timeline(caseId)).toContain("WHATSAPP_SENT");
    });

    it("needs a reason", async () => {
      const { approvalId } = await escalatedCase("b2b_high_value");

      await expect(
        approvals.reject(merchantId, approvalId, { by: merchantName, reason: "   " }),
      ).rejects.toThrow(/needs a reason/);
    });
  });

  /* ---------------------------------------------------------------- */

  describe("the queue, the history and the numbers over them", () => {
    it("orders the queue by money at risk, not by arrival", async () => {
      const small = await escalatedCase("b2b_high_value");
      await prisma.approval.update({
        where: { id: small.approvalId },
        data: { atRiskPaise: 900 * RUPEE },
      });
      const large = await escalatedCase("b2b_high_value");
      await prisma.approval.update({
        where: { id: large.approvalId },
        data: { atRiskPaise: 88_000 * RUPEE },
      });

      const pending = await approvals.pending(merchantId);
      const mine = pending.filter((row) => [small.approvalId, large.approvalId].includes(row.id));

      expect(mine.map((row) => row.id)).toEqual([large.approvalId, small.approvalId]);
    });

    it("serves the reject dialog's own reasons with the request", async () => {
      const { approvalId } = await escalatedCase("hardship_language");
      const request = (await approvals.pending(merchantId)).find((row) => row.id === approvalId);

      expect(request?.rejectionReasons.length).toBeGreaterThanOrEqual(3);
      expect(request?.rejectionReasons.join(" ").toLowerCase()).not.toContain("margin");
    });

    it("moves a request from the queue to the history when it is answered", async () => {
      const { approvalId } = await escalatedCase("b2b_high_value");

      expect((await approvals.pending(merchantId)).some((row) => row.id === approvalId)).toBe(true);

      await approvals.reject(merchantId, approvalId, {
        by: merchantName,
        reason: "This one goes out from our inbox, not the agent's",
      });

      expect((await approvals.pending(merchantId)).some((row) => row.id === approvalId)).toBe(
        false,
      );
      expect((await approvals.history(merchantId)).some((row) => row.id === approvalId)).toBe(true);
    });

    it("computes the stats from the rows rather than storing them", async () => {
      const before = await approvals.stats(merchantId);

      const { approvalId } = await escalatedCase("b2b_high_value");
      const queued = await approvals.stats(merchantId);

      expect(queued.pending).toBe(before.pending + 1);
      expect(queued.pendingValuePaise).toBe(before.pendingValuePaise + 42_000 * RUPEE);

      await approvals.reject(merchantId, approvalId, {
        by: merchantName,
        reason: "Sales owns this account — they will handle it",
      });

      const after = await approvals.stats(merchantId);
      expect(after.pending).toBe(before.pending);
      expect(after.decisions).toBe(before.decisions + 1);
      expect(after.rejected).toBe(before.rejected + 1);
      // A refusal releases no money, so the value a yes released cannot move.
      expect(after.releasedValuePaise).toBe(before.releasedValuePaise);
    });

    it("counts a merchant's own approvals only", async () => {
      const stranger = await prisma.merchant.create({
        data: {
          email: `stranger-${RUN}@example.test`,
          displayName: `Stranger ${RUN}`,
          passwordHash: "not-a-real-hash",
        },
      });

      await escalatedCase("b2b_high_value");

      try {
        expect(await approvals.pendingCount(stranger.id)).toBe(0);
        expect(await approvals.pending(stranger.id)).toEqual([]);
      } finally {
        await prisma.merchant.delete({ where: { id: stranger.id } });
      }
    });

    it("refuses to decide another merchant's request", async () => {
      const stranger = await prisma.merchant.create({
        data: {
          email: `outsider-${RUN}@example.test`,
          displayName: `Outsider ${RUN}`,
          passwordHash: "not-a-real-hash",
        },
      });
      const { approvalId } = await escalatedCase("b2b_high_value");

      try {
        await expect(
          approvals.approve(stranger.id, approvalId, { by: "Outsider" }),
        ).rejects.toThrow(/not found/);
      } finally {
        await prisma.merchant.delete({ where: { id: stranger.id } });
      }
    });
  });
});
