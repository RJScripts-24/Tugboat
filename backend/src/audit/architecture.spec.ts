import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/**
 * The structural half of "the ledger is append-only".
 *
 * The database enforces it with a trigger, which no application code can talk
 * its way past — except through one session variable, which exists so the seed
 * and the test suite can rebuild their own fixtures. An escape hatch is only
 * honest if it is demonstrably out of reach of the thing it protects against,
 * so this asserts three things: no file under `src/` mentions the flag, the
 * only files that do are the seed and test tooling, and nothing in the
 * application writes to the ledger table except through the writer.
 */

const SRC = resolve(__dirname, "..");
const TEST_DIR = resolve(__dirname, "../../test");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

const label = (file: string) => relative(SRC, file).split(sep).join("/");

const sourceFiles = walk(SRC).filter((file) => !file.endsWith(".spec.ts"));

/** The trigger's bypass. Test tooling may set it; the application may not. */
const MAINTENANCE_FLAG = "tugboat.ledger_maintenance";

describe("the append-only escape hatch is out of the application's reach", () => {
  it("finds no mention of the maintenance flag anywhere under src/", () => {
    const offenders = sourceFiles
      .filter((file) => readFileSync(file, "utf8").includes(MAINTENANCE_FLAG))
      .map(label);

    expect(offenders).toEqual([]);
  });

  it("is named in the migration that creates the trigger, so it is discoverable", () => {
    // Guards against this suite passing because the flag was renamed and these
    // assertions quietly started checking for a string nobody uses.
    const migrations = resolve(__dirname, "../../prisma/migrations");
    const sql = walk(migrations)
      .concat(
        readdirSync(migrations, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(migrations, entry.name, "migration.sql")),
      )
      .filter((file) => file.endsWith(".sql"))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");

    expect(sql).toContain(MAINTENANCE_FLAG);
    expect(sql).toContain("audit_ledger_no_rewrite");
  });
});

describe("only the writer writes to the ledger", () => {
  /** Any Prisma call that would create, change or remove a ledger row. */
  const WRITE_PATTERN =
    /auditLedger\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)/;

  it("finds ledger writes in exactly one file, and it is the writer", () => {
    const writers = sourceFiles
      .filter((file) => WRITE_PATTERN.test(readFileSync(file, "utf8")))
      .map(label);

    expect(writers).toEqual(["audit/audit-writer.service.ts"]);
  });

  it("writes only through a caller's transaction, never the bare client", () => {
    const writer = readFileSync(join(SRC, "audit/audit-writer.service.ts"), "utf8");

    // The row and the event it evidences must land together or not at all
    // (ADR-2, ADR-9). A writer holding its own client could break that pairing.
    expect(writer).toContain("tx: Prisma.TransactionClient");
    expect(writer).not.toContain("this.prisma");
  });

  it("has no update or delete path at all — appending is the only verb", () => {
    const writer = readFileSync(join(SRC, "audit/audit-writer.service.ts"), "utf8");

    expect(writer).toContain("tx.auditLedger.create");
    expect(writer).not.toMatch(/auditLedger\s*\.\s*(update|delete|upsert)/);
  });
});

describe("the ledger cannot miss an event", () => {
  it("is written by the same function that writes a case event", () => {
    // Not a listener that might be unsubscribed: the audit append happens
    // inside `CaseEventsService.append`, so there is no way to add to a case's
    // story without adding to its evidence (D-75).
    const events = readFileSync(join(SRC, "cases/case-events.service.ts"), "utf8");

    expect(events).toContain("this.audit.append(tx,");
  });

  it("maps every event kind to an actor and an action", () => {
    // A kind with no mapping would throw at write time on the one code path
    // that must never throw. The exhaustive Record type makes it a compile
    // error; this asserts the table was not widened to `Partial`.
    const payload = readFileSync(join(SRC, "audit/ledger-payload.ts"), "utf8");

    expect(payload).toContain("Record<EventKind, { actor: LedgerActor; action: string }>");
    expect(payload).not.toContain("Partial<Record<EventKind");
  });
});

describe("the maintenance flag is confined to fixtures", () => {
  it("appears under test/ only in the suites and the helper that owns it", () => {
    const users = walk(TEST_DIR)
      .filter((file) => readFileSync(file, "utf8").includes(MAINTENANCE_FLAG))
      .map((file) => relative(TEST_DIR, file).split(sep).join("/"));

    // Nothing here asserts it *must* be used — only that if it is, it is here.
    for (const user of users)
      expect(user).toMatch(/\.(int-spec|e2e-spec)\.ts$|^ledger-maintenance/);
  });

  it("is used outside src/ and test/ only by the seed", () => {
    // The seed rebuilds the demo dataset from scratch on every run, which means
    // dropping the chains it wrote last time. That is a fixture rebuilding its
    // own fixtures, not the application editing history — but it is a real use
    // of the hatch, so it is named here rather than left to be discovered.
    const prismaDir = resolve(__dirname, "../../prisma");
    const users = walk(prismaDir)
      .filter((file) => readFileSync(file, "utf8").includes(MAINTENANCE_FLAG))
      .map((file) => relative(prismaDir, file).split(sep).join("/"));

    expect(users).toEqual(["seed.ts"]);
  });
});
