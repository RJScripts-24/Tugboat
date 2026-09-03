#!/usr/bin/env node
/**
 * Raises a handover card for every escalated case that has none.
 *
 * D-151 says every escalated case is a question somebody has to answer, and
 * B-85 closed the last path that escalated without asking one. Neither is
 * retroactive: a case escalated before those fixes sits in `escalated` with an
 * empty Approvals queue and no way to reach it, because "Escalate to me"
 * disables itself on a case that is already escalated.
 *
 * This walks the cases the Control Tower narrates — live ones and the promoted
 * batch, the same scope `narratedCases` uses — and posts the same
 * `case.handover` job the override and the diagnoser now enqueue. Nothing here
 * writes an approval directly: the job goes through `ExecutorService.raiseHandover`
 * like every other handover, so the card is built by `ask-builder` from the
 * live policy pack and the case's own ladder.
 *
 * Safe to run twice. `ApprovalsService.raise` returns any open request rather
 * than creating a second one, so a case that already has a card is skipped.
 *
 *   node scripts/raise-missing-handovers.mjs            # what it would do
 *   node scripts/raise-missing-handovers.mjs --apply    # actually queue them
 *
 * The API must be running: it owns the worker that drains the queue.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apply = process.argv.includes("--apply");
/**
 * Live cases only — the ones a real webhook opened, not the promoted batch.
 *
 * Both scopes are legitimate. Every escalated case the Control Tower narrates
 * is genuinely unanswered, batch ones included. But a queue filled with twenty
 * synthetic personas is a different demo from one holding the three cases the
 * operator actually worked, so the scope is a decision rather than a default.
 */
const liveOnly = process.argv.includes("--live-only");

for (const line of readFileSync(resolve(root, "backend/.env"), "utf8").split(/\r?\n/)) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match && !process.env[match[1]]) {
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}

const dep = (rel) => pathToFileURL(resolve(root, rel)).href;

const { PrismaClient } = await import(dep("backend/node_modules/@prisma/client/default.js"));
const { PrismaPg } = await import(dep("backend/node_modules/@prisma/adapter-pg/dist/index.js"));

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

/** Live cases and the promoted batch — the population the Control Tower shows. */
const narrated = liveOnly
  ? { simRunId: null }
  : { OR: [{ simRunId: null }, { simRun: { promotedAt: { not: null } } }] };

const stranded = await prisma.case.findMany({
  where: {
    stage: "escalated",
    ...narrated,
    approvals: { none: { decision: null } },
  },
  select: {
    id: true,
    type: true,
    amountPaise: true,
    rootCause: true,
    diagnosisConfidence: true,
    attemptsUsed: true,
    customer: { select: { name: true, optedOutAt: true } },
    _count: { select: { approvals: true } },
  },
  orderBy: { id: "asc" },
});

if (stranded.length === 0) {
  console.log("Every escalated case already has an open request. Nothing to do.");
  await prisma.$disconnect();
  process.exit(0);
}

console.log(`${stranded.length} escalated case(s) with no open request:\n`);
for (const row of stranded) {
  const asked = row._count.approvals;
  console.log(
    `  C-${row.id}  ${row.type.padEnd(19)} ₹${(row.amountPaise / 100).toLocaleString("en-IN").padStart(9)}  ` +
      `${row.customer.name.padEnd(12)} attempt ${row.attemptsUsed}  ` +
      `${asked === 0 ? "never asked" : `asked ${asked}× and answered`}` +
      `${row.customer.optedOutAt ? "  · OPTED OUT" : ""}`,
  );
}

if (!apply) {
  console.log("\nDry run. Re-run with --apply to queue a handover for each.");
  await prisma.$disconnect();
  process.exit(0);
}

/*
 * Written straight onto the queue the API already drains, rather than through a
 * new endpoint.
 *
 * A route that raises a handover for an arbitrary case id would be a route
 * somebody has to guard, and this runs once. The job shape, the queue name and
 * the id convention are the ones `BullActionQueue` uses — including its colon-
 * to-dot substitution, because Redis keys and BullMQ job ids do not agree about
 * what a colon means.
 */
// BullMQ's ESM build imports directories, which Node's strict resolver refuses.
// The CommonJS entry is the same library and loads without argument.
const { Queue } = createRequire(pathToFileURL(resolve(root, "backend/package.json")).href)("bullmq");

const queue = new Queue("tugboat-actions", {
  connection: { url: process.env.REDIS_URL },
});

console.log("\nQueuing …");

let queued = 0;
for (const row of stranded) {
  // The round suffix keeps this distinct from the handover this case was
  // already asked, the same way `raise` now does (B-87).
  const jobId = `case:${row.id}:handover:${row.attemptsUsed}:backfill`;
  const reason =
    row._count.approvals === 0
      ? `Escalated with no request raised — ${row.rootCause?.toLowerCase().replace(/_/g, " ") ?? "cause unknown"}`
      : "Escalated again after its previous handover was answered";

  try {
    await queue.add(
      "case.handover",
      { kind: "case.handover", caseId: row.id, jobId, reason },
      { jobId: jobId.replaceAll(":", "."), removeOnComplete: 200, removeOnFail: 500 },
    );
    queued += 1;
    console.log(`  C-${row.id} queued`);
  } catch (error) {
    console.log(`  C-${row.id} refused: ${error.message}`);
  }
}

console.log(`\n${queued} of ${stranded.length} queued. Open /approvals once the worker has drained.`);
await queue.close();
await prisma.$disconnect();
