import "dotenv/config";

import { randomUUID } from "node:crypto";

import { Test } from "@nestjs/testing";
import type { Prisma } from "@prisma/client";

import { AgentWorker } from "../src/agent-core/agent-worker";
import { ExecutorService } from "../src/agent-core/executor.service";
import { AppModule } from "../src/app.module";
import { ClockService } from "../src/common/clock.service";
import { ApprovalsService } from "../src/approvals/approvals.service";
import { AuditService } from "../src/audit/audit.service";
import { PolicyService } from "../src/policy/policy.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { ACTION_QUEUE } from "../src/queue/action-queue.interface";
import { InlineActionQueue } from "../src/queue/inline-action-queue";
import { daylightIt } from "./daytime-clock";
import { purgeLedgerForCases, tamperWithLedgerRow } from "./ledger-maintenance";

/**
 * INTEGRATION SUITE — needs a real database (`npm run test:int`).
 *
 * The Stage 7 Definition of Done: every domain event lands on a hash-chained
 * ledger row; tampering with any historical row breaks verification at exactly
 * that row and at every row after it; and the database itself refuses an UPDATE
 * or a DELETE against the table.
 */
describe("Audit ledger (integration)", () => {
  const RUN = randomUUID().slice(0, 8);
  const RUPEE = 100;

  let prisma: PrismaService;
  let audit: AuditService;
  let executor: ExecutorService;
  let approvals: ApprovalsService;
  let policy: PolicyService;
  let queue: InlineActionQueue;
  let clock: ClockService;
  let merchantId: string;
  let merchantName: string;

  // The chains these tests verify are built by real sends; see ./daytime-clock.
  const itd = daylightIt(() => clock);

  const touchedCases: number[] = [];
  const startedAt = new Date();

  async function openCase(
    overrides: Partial<Prisma.CaseUncheckedCreateInput> = {},
    customerOverrides: Partial<Prisma.CustomerUncheckedCreateInput> = {},
  ): Promise<number> {
    const tag = randomUUID().slice(0, 6);

    const customer = await prisma.customer.create({
      data: {
        merchantId,
        name: `Audit ${RUN} ${tag}`,
        email: `audit-${RUN}-${tag}@example.test`,
        phone: `+9195${RUN.replace(/\D/g, "").padEnd(6, "3").slice(0, 6)}22`,
        maskedEmail: "a•••••@example.test",
        maskedPhone: "95•••••322",
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

    touchedCases.push(record.id);
    return record.id;
  }

  /** A case that has actually been worked, so its chain has something in it. */
  async function workedCase(): Promise<{ caseId: number; chain: string }> {
    const caseId = await openCase();
    await executor.step(caseId);
    return { caseId, chain: `C-${caseId}` };
  }

  function ledgerFor(chain: string) {
    return prisma.auditLedger.findMany({ where: { chain }, orderBy: { seq: "asc" } });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ACTION_QUEUE)
      .useValue(new InlineActionQueue())
      .compile();

    const app = moduleRef.createNestApplication();
    await app.init();
    app.get(AgentWorker);

    prisma = app.get(PrismaService);
    audit = app.get(AuditService);
    executor = app.get(ExecutorService);
    approvals = app.get(ApprovalsService);
    policy = app.get(PolicyService);
    queue = app.get(ACTION_QUEUE);
    clock = app.get(ClockService);

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
    const ids = [...new Set([...touchedCases, ...cases.map((row) => row.id)])];

    // The ledger refuses ordinary deletes, so cleaning up needs the one escape
    // hatch — which lives in test tooling and nowhere else.
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

  describe("history cannot be written without evidence", () => {
    itd("writes one ledger row for every case event, in the same order", async () => {
      const { caseId, chain } = await workedCase();

      const events = await prisma.caseEvent.findMany({
        where: { caseId },
        orderBy: { seq: "asc" },
      });
      const rows = await ledgerFor(chain);

      expect(rows).toHaveLength(events.length);
      expect(rows.map((row) => row.seq)).toEqual(events.map((_, i) => i + 1));
      // The ledger is not a listener that might miss something — it is part of
      // what writing a case event *is* (D-75).
      expect(rows.map((row) => row.detail)).toEqual(events.map((event) => event.summary));
    });

    itd("attributes each row to the actor the contract names", async () => {
      const { chain } = await workedCase();
      const rows = await ledgerFor(chain);

      const byAction = new Map(rows.map((row) => [row.action, row.actor]));
      expect(byAction.get("ACTION_PLANNED")).toBe("BOA");
      expect(byAction.get("POLICY_EVALUATED")).toBe("POLICY");
      expect(byAction.get("ACTION_EXECUTED")).toBe("BOA");
    });

    itd("starts every chain at ten zeroes and links each row to the one before", async () => {
      const { chain } = await workedCase();
      const rows = await ledgerFor(chain);

      expect(rows[0].prevHash).toBe("0".repeat(10));
      for (let i = 1; i < rows.length; i += 1) {
        expect(rows[i].prevHash).toBe(rows[i - 1].hash);
        expect(rows[i].prevSha256).toBe(rows[i - 1].sha256);
      }
    });

    itd("keeps a case's chain to itself", async () => {
      const first = await workedCase();
      const second = await workedCase();

      const rows = await ledgerFor(first.chain);
      expect(rows.every((row) => row.caseId === first.caseId)).toBe(true);
      expect(second.chain).not.toBe(first.chain);
      // Two cases both start at seq 1: removing a row from one still breaks
      // that one, and neither has to be replayed to verify the other.
      expect((await ledgerFor(second.chain))[0].seq).toBe(1);
    });

    itd("rolls the ledger row back with the event when the transaction fails", async () => {
      const caseId = await openCase();
      const before = (await ledgerFor(`C-${caseId}`)).length;

      // An illegal transition throws inside the transaction that would have
      // written both rows. Neither may survive.
      await expect(
        executor["cases"].transition(caseId, "detected", {
          kind: "HALTED",
          title: "impossible",
          summary: "this transition is not legal from diagnosed",
        }),
      ).rejects.toThrow(/Illegal case transition/);

      expect(await ledgerFor(`C-${caseId}`)).toHaveLength(before);
      expect(await prisma.caseEvent.count({ where: { caseId, title: "impossible" } })).toBe(0);
    });
  });

  /* ---------------------------------------------------------------- */

  describe("the rows carry what the contract says they carry", () => {
    itd("masks the contact before storage and lists the path that was masked", async () => {
      const { caseId, chain } = await workedCase();
      const customer = await prisma.customer.findFirstOrThrow({
        where: { cases: { some: { id: caseId } } },
      });

      const sent = (await ledgerFor(chain)).find((row) => row.action === "ACTION_EXECUTED");
      expect(sent).toBeDefined();

      const serialised = JSON.stringify(sent!.payload);
      expect(serialised).not.toContain(customer.phone);
      expect(serialised).not.toContain(customer.email);
      expect(sent!.masked).toContain("recipient");
    });

    itd("references the message body by shape rather than storing it", async () => {
      const { chain } = await workedCase();
      const sent = (await ledgerFor(chain)).find((row) => row.action === "ACTION_EXECUTED");
      const payload = sent!.payload as Record<string, unknown>;

      expect(typeof payload.body_lines).toBe("number");
      expect(JSON.stringify(payload)).not.toContain("Reply STOP");
    });

    itd("keeps the gate's full checklist, which is what the compliance figures are counted from", async () => {
      const { chain } = await workedCase();
      const check = (await ledgerFor(chain)).find((row) => row.action === "POLICY_EVALUATED");
      const payload = check!.payload as { verdict: string; checks: { name: string }[] };

      expect(payload.verdict).toBe("PASS");
      expect(payload.checks.length).toBeGreaterThanOrEqual(8);
      expect(payload.checks.map((entry) => entry.name)).toContain("Opt-out");
    });

    itd("ships the preimage, so the browser can recompute rather than be told", async () => {
      const { chain } = await workedCase();
      const { rows } = await audit.list(merchantId, { chain });

      for (const row of rows) {
        expect(row.seed).toContain(chain);
        expect(row.hash).toMatch(/^[0-9a-f]{10}$/);
        expect(row.id).toBe(`${row.chain}#${row.seq}`);
      }
    });
  });

  /* ---------------------------------------------------------------- */

  describe("verification", () => {
    itd("passes on a chain nobody has touched", async () => {
      const { chain } = await workedCase();
      const verdict = await audit.verify(merchantId, { chain });

      expect(verdict.broken).toEqual([]);
      expect(verdict.checked).toBeGreaterThan(0);
      expect(verdict.chains).toBe(1);
    });

    itd("breaks at exactly the tampered row, and at every row after it", async () => {
      const { chain } = await workedCase();
      const rows = await ledgerFor(chain);
      // Plan, gate, send — enough of a chain that "and every row after it" is a
      // claim with something behind it.
      expect(rows.length).toBeGreaterThanOrEqual(3);

      const target = rows[1];
      await tamperWithLedgerRow(prisma, target.id, {
        payload: { ...(target.payload as object), amount_paise: 1 },
      });

      const verdict = await audit.verify(merchantId, { chain });
      const seqs = verdict.broken.map((entry) => entry.seq);

      expect(seqs[0]).toBe(target.seq);
      expect(seqs).toEqual(rows.slice(1).map((row) => row.seq));
      expect(verdict.broken[0].reason).toContain("no longer produces its own preimage");
      expect(verdict.broken[0].id).toBe(`${chain}#${target.seq}`);
    });

    itd("catches a detail line edited to say something friendlier", async () => {
      const { chain } = await workedCase();
      const rows = await ledgerFor(chain);
      const target = rows[rows.length - 1];

      await tamperWithLedgerRow(prisma, target.id, { detail: "nothing to see here" });

      const verdict = await audit.verify(merchantId, { chain });
      expect(verdict.broken.map((entry) => entry.seq)).toEqual([target.seq]);
    });

    itd("catches a row removed from the middle of a chain", async () => {
      const { caseId, chain } = await workedCase();
      const rows = await ledgerFor(chain);

      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL "tugboat.ledger_maintenance" = 'on'`);
        await tx.auditLedger.delete({ where: { id: rows[1].id } });
      });

      const verdict = await audit.verify(merchantId, { chain });

      expect(verdict.broken[0].reason).toContain("link broken");
      expect(verdict.broken[0].seq).toBe(rows[2].seq);
      expect(caseId).toBeGreaterThan(0);
    });

    itd("leaves other chains verifying when one is broken", async () => {
      const damaged = await workedCase();
      const healthy = await workedCase();

      const rows = await ledgerFor(damaged.chain);
      await tamperWithLedgerRow(prisma, rows[0].id, { detail: "rewritten" });

      expect(
        (await audit.verify(merchantId, { chain: damaged.chain })).broken.length,
      ).toBeGreaterThan(0);
      expect((await audit.verify(merchantId, { chain: healthy.chain })).broken).toEqual([]);
    });

    itd("names both digests it checked with", async () => {
      const verdict = await audit.verify(merchantId, { chain: (await workedCase()).chain });

      expect(verdict.digests.browser).toContain("fnv1a");
      expect(verdict.digests.server).toBe("sha256");
    });
  });

  /* ---------------------------------------------------------------- */

  describe("the database refuses to rewrite a written row", () => {
    itd("rejects an UPDATE", async () => {
      const { chain } = await workedCase();
      const row = (await ledgerFor(chain))[0];

      // ADR-9's second mechanism: the chain makes an edit detectable, this
      // makes an ordinary edit fail. No application role can talk past it.
      await expect(
        prisma.auditLedger.update({ where: { id: row.id }, data: { detail: "tampered" } }),
      ).rejects.toThrow(/append-only/);

      const after = await prisma.auditLedger.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.detail).toBe(row.detail);
    });

    itd("rejects a DELETE", async () => {
      const { chain } = await workedCase();
      const row = (await ledgerFor(chain))[0];

      await expect(prisma.auditLedger.delete({ where: { id: row.id } })).rejects.toThrow(
        /append-only/,
      );

      expect(await prisma.auditLedger.count({ where: { id: row.id } })).toBe(1);
    });

    itd("rejects a bulk UPDATE across the whole table", async () => {
      await expect(
        prisma.auditLedger.updateMany({
          where: { merchantId },
          data: { actor: "SYSTEM" },
        }),
      ).rejects.toThrow(/append-only/);
    });

    itd("still allows an INSERT — appending is the whole point", async () => {
      const before = await prisma.auditLedger.count({ where: { merchantId } });
      await workedCase();

      expect(await prisma.auditLedger.count({ where: { merchantId } })).toBeGreaterThan(before);
    });
  });

  /* ---------------------------------------------------------------- */

  describe("the policy pack has its own chain", () => {
    itd("records a policy edit as a HUMAN row on the policy chain", async () => {
      const before = await prisma.auditLedger.count({
        where: { merchantId, chain: "policy" },
      });

      const active = await policy.getActive(merchantId);
      const next = structuredClone(active.pack);
      next.contact.coolDownHours = next.contact.coolDownHours === 20 ? 21 : 20;
      await policy.save(merchantId, next, merchantName);

      const rows = await prisma.auditLedger.findMany({
        where: { merchantId, chain: "policy" },
        orderBy: { seq: "asc" },
      });

      expect(rows.length).toBe(before + 1);

      const newest = rows[rows.length - 1];
      expect(newest.actor).toBe("HUMAN");
      expect(newest.action).toBe("POLICY_CHANGED");
      expect(newest.caseId).toBeNull();

      const payload = newest.payload as { changed_by: string; changes: string[] };
      expect(payload.changed_by).toBe(merchantName);
      expect(payload.changes.join(" ")).toContain("coolDownHours");
    });

    itd("verifies as its own chain, unaffected by any case", async () => {
      const verdict = await audit.verify(merchantId, { chain: "policy" });
      expect(verdict.broken).toEqual([]);
    });
  });

  /* ---------------------------------------------------------------- */

  describe("GET /audit", () => {
    itd("filters to one case", async () => {
      const { caseId, chain } = await workedCase();
      const { rows, total } = await audit.list(merchantId, { caseId });

      expect(total).toBeGreaterThan(0);
      expect(rows.every((row) => row.chain === chain)).toBe(true);
      expect(rows.every((row) => row.caseId === chain)).toBe(true);
    });

    itd("filters by actor and by action", async () => {
      const { caseId } = await workedCase();

      const byActor = await audit.list(merchantId, { caseId, actor: ["POLICY"] });
      expect(byActor.rows.length).toBeGreaterThan(0);
      expect(byActor.rows.every((row) => row.actor === "POLICY")).toBe(true);

      const byAction = await audit.list(merchantId, { caseId, action: ["ACTION_EXECUTED"] });
      expect(byAction.rows.every((row) => row.action === "ACTION_EXECUTED")).toBe(true);
    });

    itd("filters by time range", async () => {
      const { caseId } = await workedCase();
      const all = await audit.list(merchantId, { caseId });
      const newest = Math.max(...all.rows.map((row) => row.atMs));

      const future = await audit.list(merchantId, { caseId, fromMs: newest + 60_000 });
      expect(future.total).toBe(0);

      const past = await audit.list(merchantId, { caseId, toMs: newest });
      expect(past.total).toBeGreaterThan(0);
    });

    itd("pages without losing rows", async () => {
      const { caseId } = await workedCase();
      const all = await audit.list(merchantId, { caseId });

      const first = await audit.list(merchantId, { caseId, take: 2 });
      const second = await audit.list(merchantId, { caseId, skip: 2 });

      expect(first.rows).toHaveLength(Math.min(2, all.total));
      expect(first.rows.length + second.rows.length).toBe(all.total);
      expect(first.total).toBe(all.total);
    });

    itd("returns newest first", async () => {
      const { caseId } = await workedCase();
      const { rows } = await audit.list(merchantId, { caseId });

      for (let i = 1; i < rows.length; i += 1) {
        expect(rows[i - 1].atMs).toBeGreaterThanOrEqual(rows[i].atMs);
      }
    });

    itd("reports the tip of each chain, so an appended row continues it", async () => {
      const { chain } = await workedCase();
      const rows = await ledgerFor(chain);
      const tips = await audit.tips(merchantId);

      expect(tips[chain]).toEqual({
        hash: rows[rows.length - 1].hash,
        seq: rows[rows.length - 1].seq,
      });
    });

    itd("shows a merchant only their own rows", async () => {
      const stranger = await prisma.merchant.create({
        data: {
          email: `ledger-outsider-${RUN}@example.test`,
          displayName: `Outsider ${RUN}`,
          passwordHash: "not-a-real-hash",
        },
      });

      await workedCase();

      try {
        expect((await audit.list(stranger.id, {})).total).toBe(0);
        expect((await audit.verify(stranger.id)).checked).toBe(0);
      } finally {
        await prisma.merchant.delete({ where: { id: stranger.id } });
      }
    });
  });

  /* ---------------------------------------------------------------- */

  describe("a human decision reaches the ledger as a human decision", () => {
    itd("records an approval with HUMAN against it", async () => {
      const caseId = await openCase(
        { amountPaise: 42_000 * RUPEE, type: "INVOICE_OVERDUE" },
        { segment: "B2B" },
      );
      await executor.step(caseId);

      const approval = await prisma.approval.findFirstOrThrow({ where: { caseId } });
      await approvals.approve(merchantId, approval.id, { by: merchantName });
      await queue.drain();

      const rows = await ledgerFor(`C-${caseId}`);
      const decision = rows.find((row) => row.action === "APPROVAL_DECIDED");

      expect(decision).toBeDefined();
      expect(decision!.actor).toBe("HUMAN");
      expect(decision!.detail).toContain("Released after");

      // And the chain still verifies with a human's row in the middle of it.
      expect((await audit.verify(merchantId, { chain: `C-${caseId}` })).broken).toEqual([]);
    });

    itd("records the escalation that preceded it as a POLICY row", async () => {
      const caseId = await openCase({ diagnosisConfidence: 0.4, rootCause: "UNKNOWN" });
      await executor.step(caseId);

      const rows = await ledgerFor(`C-${caseId}`);
      const escalation = rows.find((row) => row.action === "ESCALATION_RAISED");

      expect(escalation).toBeDefined();
      expect(escalation!.actor).toBe("POLICY");
    });
  });
});
