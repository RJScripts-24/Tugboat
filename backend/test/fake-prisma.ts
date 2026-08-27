import { Prisma } from "@prisma/client";

import { hashPassword } from "../src/common/password";

type FakeWebhookEvent = {
  eventId: string;
  source: string;
  eventType: string;
  payload: unknown;
  receivedAt: Date;
  processedAt: Date | null;
  caseId: number | null;
};

/** The real thing Prisma throws on a unique-constraint violation, so the code under test branches identically. */
function uniqueViolation(target: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: Prisma.prismaVersion.client,
    meta: { target: [target] },
  });
}

/**
 * An in-memory stand-in for PrismaService.
 *
 * The e2e suites exercise the HTTP contract — status codes, bodies, guards —
 * which does not need a database, and giving them one would make them slow,
 * order-dependent, and destructive to whatever is in Neon. Real schema
 * behaviour is proven by `prisma migrate` and the seed, not by these tests.
 */
export type FakeMerchant = {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  createdAt: Date;
};

export const DEMO = {
  email: "demo@tugboat.dev",
  password: "tugboat-demo",
  displayName: "Demo Merchant",
};

const RUPEE = 100;

/** Policy v4, matching the seed — the pack the e2e contract is served from. */
export const FAKE_POLICY_V4 = {
  contact: {
    maxAttempts: 4,
    coolDownHours: 20,
    channelCaps: { WHATSAPP: 2, EMAIL: 2, VOICE: 1, RETRY: 2 },
  },
  quiet: { startMinutes: 21 * 60, endMinutes: 9 * 60, exemptSilentRetries: true },
  rules: { opt_out: true, sentiment: true, deadline: true, attempt_cap: true },
  sentimentThreshold: 0.7,
  escalation: {
    discountCapPercent: 15,
    valueThresholdPaise: 25_000 * RUPEE,
    b2bAlways: true,
    confidenceFloor: 0.6,
    hardship: true,
  },
  mandate: { maxPerCycle: 3, spacingDays: 3, alignToPayday: true },
  channels: { WHATSAPP: true, EMAIL: true, VOICE: true, RETRY: true },
};

type FakeLedgerRow = {
  id: string;
  merchantId: string;
  chain: string;
  seq: number;
  hash: string;
  sha256: string;
  [key: string]: unknown;
};

type FakePolicyVersion = {
  id: string;
  merchantId: string;
  version: string;
  pack: unknown;
  hash: string;
  note: string | null;
  changes: string[];
  isActive: boolean;
  createdBy: string | null;
  createdAt: Date;
};

export async function createFakePrisma(options: { databaseUp?: boolean } = {}) {
  const merchants: FakeMerchant[] = [
    {
      id: "merchant_demo",
      email: DEMO.email,
      displayName: DEMO.displayName,
      passwordHash: await hashPassword(DEMO.password),
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
    },
  ];

  const webhookEvents = new Map<string, FakeWebhookEvent>();

  /**
   * The ledger, crudely.
   *
   * `PolicyService.save` writes a row on the "policy" chain inside the same
   * transaction that cuts a version, so the HTTP contract cannot run without
   * somewhere for it to land. Sequencing and the digests are the real writer's
   * job and are proven against a real database in `audit.int-spec.ts`; this
   * only has to accept an append and hand back the previous tip.
   */
  const ledger: FakeLedgerRow[] = [];

  const policyVersions: FakePolicyVersion[] = [
    {
      id: "policy_v4",
      merchantId: "merchant_demo",
      version: "v4",
      pack: FAKE_POLICY_V4,
      hash: "seedhash00000000",
      note: "Voice capped at one call per case",
      changes: ["contact.channelCaps.VOICE 2 → 1", "mandate.alignToPayday off → on"],
      isActive: true,
      createdBy: DEMO.displayName,
      createdAt: new Date("2026-08-20T00:00:00.000Z"),
    },
  ];

  let policySequence = 0;

  const client: Record<string, unknown> = {
    ping: async () => options.databaseUp !== false,
    merchant: {
      findUnique: async ({ where }: { where: { email: string } }) =>
        merchants.find((m) => m.email === where.email) ?? null,
      findFirst: async () => merchants[0] ?? null,
    },
    webhookEvent: {
      create: async ({
        data,
      }: {
        data: Omit<FakeWebhookEvent, "receivedAt" | "processedAt" | "caseId"> &
          Partial<FakeWebhookEvent>;
      }) => {
        if (webhookEvents.has(data.eventId)) throw uniqueViolation("eventId");

        const row: FakeWebhookEvent = {
          eventId: data.eventId,
          source: data.source,
          eventType: data.eventType,
          payload: data.payload,
          receivedAt: new Date(),
          processedAt: data.processedAt ?? null,
          caseId: null,
        };
        webhookEvents.set(row.eventId, row);
        return row;
      },
      findUnique: async ({ where }: { where: { eventId: string } }) =>
        webhookEvents.get(where.eventId) ?? null,
      update: async ({
        where,
        data,
      }: {
        where: { eventId: string };
        data: Partial<FakeWebhookEvent>;
      }) => {
        const row = webhookEvents.get(where.eventId);
        if (!row) throw new Error(`No webhookEvent ${where.eventId}`);
        Object.assign(row, data);
        return row;
      },
    },
    // The detector's tables. Enough for the HTTP paths to run end to end; the
    // statistics themselves are proven by unit tests and the integration suite.
    paymentSample: {
      create: async ({ data }: { data: unknown }) => data,
      findMany: async () => [],
      count: async () => 0,
    },
    degradationIncident: {
      findFirst: async () => null,
      create: async ({ data }: { data: unknown }) => data,
      update: async ({ data }: { data: unknown }) => data,
    },
    llmCall: {
      create: async ({ data }: { data: unknown }) => data,
      count: async () => 0,
    },
    policyVersion: {
      findFirst: async ({ where }: { where: { merchantId: string; isActive?: boolean } }) =>
        policyVersions.find(
          (row) =>
            row.merchantId === where.merchantId &&
            (where.isActive === undefined || row.isActive === where.isActive),
        ) ?? null,
      findMany: async ({ where }: { where: { merchantId: string } }) =>
        policyVersions
          .filter((row) => row.merchantId === where.merchantId)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
      create: async ({ data }: { data: Omit<FakePolicyVersion, "id" | "createdAt"> }) => {
        if (
          policyVersions.some(
            (row) => row.merchantId === data.merchantId && row.version === data.version,
          )
        ) {
          throw uniqueViolation("merchantId_version");
        }

        policySequence += 1;
        const row: FakePolicyVersion = {
          ...data,
          id: `policy_${policySequence}`,
          // Ordered strictly after every existing row, so the revision chain
          // keeps the order the versions were cut in.
          createdAt: new Date(Date.now() + policySequence),
        };
        policyVersions.push(row);
        return row;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { merchantId: string; isActive?: boolean };
        data: Partial<FakePolicyVersion>;
      }) => {
        const matched = policyVersions.filter(
          (row) =>
            row.merchantId === where.merchantId &&
            (where.isActive === undefined || row.isActive === where.isActive),
        );
        for (const row of matched) Object.assign(row, data);
        return { count: matched.length };
      },
    },
    auditLedger: {
      findFirst: async ({ where }: { where: { merchantId: string; chain: string } }) =>
        ledger
          .filter((row) => row.merchantId === where.merchantId && row.chain === where.chain)
          .sort((a, b) => b.seq - a.seq)[0] ?? null,
      findMany: async ({
        where,
        distinct,
      }: {
        where?: { merchantId?: string; chain?: string };
        distinct?: string[];
      } = {}) => {
        const rows = ledger
          .filter(
            (row) =>
              (where?.merchantId === undefined || row.merchantId === where.merchantId) &&
              (where?.chain === undefined || row.chain === where.chain),
          )
          .sort((a, b) => a.seq - b.seq);

        if (!distinct?.includes("chain")) return rows;

        const seen = new Set<string>();
        return rows.filter((row) => (seen.has(row.chain) ? false : seen.add(row.chain) && true));
      },
      create: async ({ data }: { data: FakeLedgerRow }) => {
        const row = { ...data, id: `ledger_${ledger.length + 1}` };
        ledger.push(row);
        return row;
      },
      count: async () => ledger.length,
      // `distinct` and `groupBy` exist only because the summary endpoint asks
      // for them. Crude on purpose: the real aggregation is Postgres's job.
      groupBy: async ({ where }: { where?: { merchantId?: string } } = {}) => {
        const counts = new Map<string, number>();
        for (const row of ledger) {
          if (where?.merchantId !== undefined && row.merchantId !== where.merchantId) continue;
          const actor = String(row.actor);
          counts.set(actor, (counts.get(actor) ?? 0) + 1);
        }
        return [...counts.entries()].map(([actor, count]) => ({ actor, _count: { _all: count } }));
      },
    },
    // Stage 8's boot hook reaps runs whose process died, so every app that
    // registers the simulator asks for this table before it serves a request —
    // including the ones here, which never start a batch. Nothing else in these
    // suites touches it: a run is fifteen minutes of real work against a real
    // database and belongs to the integration tier (simulation.int-spec.ts).
    simRun: {
      updateMany: async () => ({ count: 0 }),
    },
    // The gate's own write path is proven against the real database
    // (policy-gate.int-spec.ts); this only has to let the HTTP layer run.
    policyDecision: {
      create: async ({ data }: { data: unknown }) => ({ id: "decision_fake", ...(data as object) }),
      count: async () => 0,
    },
    // Interactive transactions hand the callback the same client. There is no
    // rollback here: these suites assert the HTTP contract, and anything that
    // depends on a transaction actually being atomic is proven against the real
    // database in the integration tier.
    $transaction: async <T>(run: (tx: unknown) => Promise<T>): Promise<T> => run(client),
    // The real service wraps `$transaction` so domain events flush on commit
    // (D-100). These suites assert the HTTP contract, so the wrapper here is the
    // transaction itself — the flush is proven where it matters, against a real
    // database in the integration tier.
    transaction: async <T>(run: (tx: unknown) => Promise<T>): Promise<T> => run(client),
    $connect: async () => undefined,
    $disconnect: async () => undefined,
  };

  return client;
}
