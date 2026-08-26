import type { PrismaService } from "../src/prisma/prisma.service";

/**
 * The one way past the append-only trigger, and it lives here.
 *
 * `audit_ledger` refuses UPDATE and DELETE at the database (ADR-9, D-76). That
 * is the point — but a test suite that writes rows against a shared Neon
 * instance has to be able to take them away again, or every run leaves the demo
 * ledger a little more full of fixtures.
 *
 * So the trigger honours one session variable, and this file is the only place
 * that sets it. `src/audit/architecture.spec.ts` asserts that no file under
 * `src/` mentions it, which is what makes "the application cannot rewrite the
 * ledger" a checked claim rather than a promise: the escape hatch exists, and
 * it is demonstrably out of reach of the thing it protects against.
 *
 * `SET LOCAL` scopes it to the surrounding transaction, so it cannot leak into
 * the next query on a pooled connection.
 */
const MAINTENANCE_FLAG = "tugboat.ledger_maintenance";

export async function purgeLedgerForCases(
  prisma: PrismaService,
  caseIds: number[],
): Promise<number> {
  if (caseIds.length === 0) return 0;

  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL "${MAINTENANCE_FLAG}" = 'on'`);
    const { count } = await tx.auditLedger.deleteMany({ where: { caseId: { in: caseIds } } });
    return count;
  });
}

export async function purgeLedgerChain(prisma: PrismaService, chain: string): Promise<number> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL "${MAINTENANCE_FLAG}" = 'on'`);
    const { count } = await tx.auditLedger.deleteMany({ where: { chain } });
    return count;
  });
}

/** Edits a stored row, so a test can prove the chain notices. */
export async function tamperWithLedgerRow(
  prisma: PrismaService,
  id: string,
  data: Record<string, unknown>,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL "${MAINTENANCE_FLAG}" = 'on'`);
    await tx.auditLedger.update({ where: { id }, data: data as never });
  });
}
