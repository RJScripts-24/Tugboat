import "dotenv/config";

import { createHash } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type CaseStage, type CaseType, type RootCause } from "@prisma/client";

import { hashPassword } from "../src/common/password";

/**
 * Seeds the one demo merchant, policy pack v4, and a small hand-written case
 * set that exercises all four playbooks and most of the state machine.
 *
 * Re-runnable: the case set is cleared and rebuilt on every run, so `db:seed`
 * twice leaves the same database as `db:seed` once. Stage 8 replaces this set
 * with the simulator's seeded batch.
 */

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL }),
});

const RUPEE = 100;

const DEMO_MERCHANT = {
  email: "demo@tugboat.dev",
  password: "tugboat-demo",
  displayName: "Demo Merchant",
};

/** Policy v4 — the pack the seeded batch was worked under (build prompt §3.2). */
const POLICY_V4 = {
  contact: {
    maxAttempts: 4,
    coolDownHours: 20,
    channelCaps: { WHATSAPP: 2, EMAIL: 2, VOICE: 1, RETRY: 2 },
  },
  quiet: {
    startMinutes: 21 * 60,
    endMinutes: 9 * 60,
    exemptSilentRetries: true,
  },
  rules: {
    opt_out: true,
    sentiment: true,
    deadline: true,
    attempt_cap: true,
  },
  sentimentThreshold: 0.7,
  escalation: {
    discountCapPercent: 15,
    valueThresholdPaise: 25_000 * RUPEE,
    b2bAlways: true,
    confidenceFloor: 0.6,
    hardship: true,
  },
  mandate: {
    maxPerCycle: 3,
    spacingDays: 3,
    alignToPayday: true,
  },
  channels: { WHATSAPP: true, EMAIL: true, VOICE: true, RETRY: true },
};

const ACTIVE_POLICY_VERSION = "v4";

/** v1 shipped with two voice calls allowed and no payday alignment. */
const POLICY_V1 = {
  ...POLICY_V4,
  contact: { ...POLICY_V4.contact, channelCaps: { ...POLICY_V4.contact.channelCaps, VOICE: 2 } },
  mandate: { ...POLICY_V4.mandate, alignToPayday: false },
};

/** v2 was the weekend push: more attempts, a quarter of the cool-down. */
const POLICY_V2 = {
  ...POLICY_V1,
  contact: { ...POLICY_V1.contact, maxAttempts: 6, coolDownHours: 6 },
};

/** Every version ever cut for the demo merchant, oldest first. */
const POLICY_HISTORY = [
  {
    version: "v1",
    pack: POLICY_V1,
    daysAgo: 16,
    // No author: a system-created row renders as SYSTEM / "Tugboat".
    by: null as string | null,
    summary: "Shipped defaults — quiet hours, attempt caps, opt-out locked on",
    changes: ["policy pack created"],
  },
  {
    version: "v2",
    pack: POLICY_V2,
    daysAgo: 11,
    by: DEMO_MERCHANT.displayName,
    summary: "Loosened for a weekend push — three complaints in two days",
    changes: ["contact.coolDownHours 20h → 6h", "contact.maxAttempts 4 → 6"],
  },
  {
    version: "v3",
    pack: POLICY_V1,
    daysAgo: 9,
    by: DEMO_MERCHANT.displayName,
    summary: "Reverted v2 — the cool-down goes back to 20h",
    changes: ["contact.coolDownHours 6h → 20h", "contact.maxAttempts 6 → 4"],
  },
  {
    version: ACTIVE_POLICY_VERSION,
    pack: POLICY_V4,
    daysAgo: 4,
    by: DEMO_MERCHANT.displayName,
    summary: "Voice capped at one call per case",
    changes: ["contact.channelCaps.VOICE 2 → 1", "mandate.alignToPayday off → on"],
  },
];

type Seeded = {
  customer: string;
  segment: "B2C" | "B2B";
  language: "en-IN" | "hi-IN";
  phone: string;
  email: string;
  type: CaseType;
  amountRupees: number;
  stage: CaseStage;
  rootCause: RootCause | null;
  confidence: number | null;
  method: "RULES" | "LLM" | null;
  attempts: number;
  attemptCap: number;
  recoveredRupees: number;
  optedOut?: boolean;
  hoursAgo: number;
};

/**
 * Twelve cases spanning all four types and nine stages. Amounts, causes and
 * attempt counts are internally consistent: a recovered case has recovered its
 * full amount, an exhausted one has spent its cap, and an escalated one has not.
 */
const CASES: Seeded[] = [
  {
    customer: "Nova Foods",
    segment: "B2C",
    language: "hi-IN",
    phone: "9711204431",
    email: "orders@novafoods.in",
    type: "PAYMENT_FAILED",
    amountRupees: 2_340,
    stage: "recovered",
    rootCause: "BANK_GATEWAY_DEGRADED",
    confidence: 0.93,
    method: "RULES",
    attempts: 1,
    attemptCap: 4,
    recoveredRupees: 2_340,
    hoursAgo: 21,
  },
  {
    customer: "Lumen Studio",
    segment: "B2C",
    language: "en-IN",
    phone: "7042318826",
    email: "hello@lumenstudio.co",
    type: "PAYMENT_FAILED",
    amountRupees: 12_050,
    stage: "recovered",
    rootCause: "INSUFFICIENT_FUNDS",
    confidence: 0.91,
    method: "RULES",
    attempts: 3,
    attemptCap: 4,
    recoveredRupees: 12_050,
    hoursAgo: 29,
  },
  {
    customer: "Acme Labs",
    segment: "B2B",
    language: "en-IN",
    phone: "9822010210",
    email: "ap@acmelabs.in",
    type: "PAYMENT_FAILED",
    amountRupees: 4_800,
    stage: "intervening",
    rootCause: "CARD_EXPIRED",
    confidence: 0.71,
    method: "LLM",
    attempts: 1,
    attemptCap: 4,
    recoveredRupees: 0,
    hoursAgo: 3,
  },
  {
    customer: "Tiller Group",
    segment: "B2B",
    language: "en-IN",
    phone: "8126730390",
    email: "finance@tillergroup.in",
    type: "PAYMENT_FAILED",
    amountRupees: 7_600,
    stage: "escalated",
    rootCause: "UNKNOWN",
    confidence: 0.41,
    method: "LLM",
    attempts: 0,
    attemptCap: 4,
    recoveredRupees: 0,
    hoursAgo: 8,
  },
  {
    customer: "Orbit Retail",
    segment: "B2C",
    language: "hi-IN",
    phone: "9004427118",
    email: "orbit.retail@gmail.com",
    type: "CHECKOUT_ABANDONED",
    amountRupees: 8_200,
    stage: "waiting",
    rootCause: "CUSTOMER_DISTRACTED",
    confidence: 0.68,
    method: "LLM",
    attempts: 2,
    attemptCap: 4,
    recoveredRupees: 0,
    hoursAgo: 5,
  },
  {
    customer: "Beam Interiors",
    segment: "B2B",
    language: "en-IN",
    phone: "8890442905",
    email: "accounts@beaminteriors.in",
    type: "CHECKOUT_ABANDONED",
    amountRupees: 2_400,
    stage: "escalated",
    rootCause: "CUSTOMER_DISTRACTED",
    confidence: 0.62,
    method: "LLM",
    attempts: 2,
    attemptCap: 4,
    recoveredRupees: 0,
    hoursAgo: 6,
  },
  {
    customer: "Piyush Ranjan",
    segment: "B2C",
    language: "hi-IN",
    phone: "9930118842",
    email: "piyush.ranjan@gmail.com",
    type: "CHECKOUT_ABANDONED",
    amountRupees: 1_180,
    stage: "detected",
    rootCause: null,
    confidence: null,
    method: null,
    attempts: 0,
    attemptCap: 4,
    recoveredRupees: 0,
    hoursAgo: 1,
  },
  {
    customer: "Sunrise Dairy",
    segment: "B2C",
    language: "hi-IN",
    phone: "9663270077",
    email: "sunrisedairy@outlook.com",
    type: "MANDATE_FAILED",
    amountRupees: 1_499,
    stage: "intervening",
    rootCause: "INSUFFICIENT_FUNDS",
    confidence: 0.96,
    method: "RULES",
    attempts: 1,
    attemptCap: 3,
    recoveredRupees: 0,
    hoursAgo: 4,
  },
  {
    customer: "Peak Fitness",
    segment: "B2C",
    language: "en-IN",
    phone: "9915520334",
    email: "billing@peakfitness.in",
    type: "MANDATE_FAILED",
    amountRupees: 999,
    stage: "exhausted",
    rootCause: "MANDATE_REVOKED",
    confidence: 0.99,
    method: "RULES",
    attempts: 3,
    attemptCap: 3,
    recoveredRupees: 0,
    hoursAgo: 44,
  },
  {
    customer: "Meera Iyer",
    segment: "B2C",
    language: "en-IN",
    phone: "9845112277",
    email: "meera.iyer@yahoo.in",
    type: "MANDATE_FAILED",
    amountRupees: 2_199,
    stage: "diagnosed",
    rootCause: "INSUFFICIENT_FUNDS",
    confidence: 0.88,
    method: "RULES",
    attempts: 0,
    attemptCap: 3,
    recoveredRupees: 0,
    hoursAgo: 2,
  },
  {
    customer: "Harbour Textiles",
    segment: "B2B",
    language: "hi-IN",
    phone: "9367215562",
    email: "accounts@harbourtextiles.in",
    type: "INVOICE_OVERDUE",
    amountRupees: 18_400,
    stage: "promised",
    rootCause: "CUSTOMER_DISTRACTED",
    confidence: 0.81,
    method: "LLM",
    attempts: 3,
    attemptCap: 4,
    recoveredRupees: 0,
    hoursAgo: 12,
  },
  {
    customer: "Kettle & Co",
    segment: "B2B",
    language: "en-IN",
    phone: "9820774310",
    email: "ops@kettleandco.in",
    type: "INVOICE_OVERDUE",
    amountRupees: 26_500,
    stage: "halted",
    rootCause: "CUSTOMER_DISTRACTED",
    confidence: 0.74,
    method: "LLM",
    attempts: 2,
    attemptCap: 4,
    recoveredRupees: 0,
    optedOut: true,
    hoursAgo: 21,
  },
];

const ORIGIN: Record<CaseType, { kind: string; prefix: string }> = {
  PAYMENT_FAILED: { kind: "Razorpay payment", prefix: "pay" },
  CHECKOUT_ABANDONED: { kind: "Razorpay order", prefix: "order" },
  MANDATE_FAILED: { kind: "Razorpay subscription", prefix: "sub" },
  INVOICE_OVERDUE: { kind: "Razorpay invoice", prefix: "inv" },
};

function maskPhone(phone: string): string {
  return `${phone.slice(0, 2)}•••••${phone.slice(-3)}`;
}

function maskEmail(email: string): string {
  const [name, domain] = email.split("@");
  return `${name.slice(0, 1)}•••••@${domain}`;
}

/** A Razorpay-shaped id, derived so a reseed produces the same ids. */
function razorpayId(prefix: string, seed: string): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const digest = createHash("sha256").update(seed).digest();
  let out = "";
  for (let i = 0; i < 14; i += 1) out += alphabet[digest[i] % alphabet.length];
  return `${prefix}_${out}`;
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

async function main(): Promise<void> {
  const merchant = await prisma.merchant.upsert({
    where: { email: DEMO_MERCHANT.email },
    update: { displayName: DEMO_MERCHANT.displayName },
    create: {
      email: DEMO_MERCHANT.email,
      displayName: DEMO_MERCHANT.displayName,
      passwordHash: await hashPassword(DEMO_MERCHANT.password),
    },
  });

  // The real revision history, not just the pack in force. v2 is deliberately a
  // loosening that was reverted two days later: a policy history in which every
  // change was an improvement is a history somebody wrote afterwards.
  for (const revision of POLICY_HISTORY) {
    const createdAt = hoursAgo(revision.daysAgo * 24);
    const common = {
      pack: revision.pack,
      hash: stableHash(revision.pack),
      note: revision.summary,
      changes: revision.changes,
      isActive: revision.version === ACTIVE_POLICY_VERSION,
      createdBy: revision.by,
      createdAt,
    };

    await prisma.policyVersion.upsert({
      where: { merchantId_version: { merchantId: merchant.id, version: revision.version } },
      update: common,
      create: { merchantId: merchant.id, version: revision.version, ...common },
    });
  }

  // Anything cut by a live demo stays in the history but stops being in force.
  await prisma.policyVersion.updateMany({
    where: { merchantId: merchant.id, version: { not: ACTIVE_POLICY_VERSION } },
    data: { isActive: false },
  });

  const policy = await prisma.policyVersion.findFirstOrThrow({
    where: { merchantId: merchant.id, version: ACTIVE_POLICY_VERSION },
  });

  // Rebuild the case set so re-running the seed does not duplicate it. Events,
  // actions and approvals cascade from the case rows.
  await prisma.case.deleteMany({ where: { merchantId: merchant.id } });
  await prisma.customer.deleteMany({ where: { merchantId: merchant.id } });
  await prisma.$executeRawUnsafe("ALTER SEQUENCE cases_id_seq RESTART WITH 1001");

  for (const spec of CASES) {
    const customer = await prisma.customer.create({
      data: {
        merchantId: merchant.id,
        name: spec.customer,
        email: spec.email,
        phone: spec.phone,
        maskedEmail: maskEmail(spec.email),
        maskedPhone: maskPhone(spec.phone),
        languagePref: spec.language,
        segment: spec.segment,
        optedOutAt: spec.optedOut ? hoursAgo(spec.hoursAgo) : null,
      },
    });

    const origin = ORIGIN[spec.type];
    const openedAt = hoursAgo(spec.hoursAgo);

    const record = await prisma.case.create({
      data: {
        merchantId: merchant.id,
        customerId: customer.id,
        type: spec.type,
        amountPaise: spec.amountRupees * RUPEE,
        stage: spec.stage,
        rootCause: spec.rootCause,
        diagnosisConfidence: spec.confidence,
        diagnosisMethod: spec.method,
        originKind: origin.kind,
        originId: razorpayId(origin.prefix, `${spec.customer}/${spec.type}`),
        attemptsUsed: spec.attempts,
        attemptCap: spec.attemptCap,
        recoveredAmountPaise: spec.recoveredRupees * RUPEE,
        deadlineAt: new Date(openedAt.getTime() + 7 * 24 * 60 * 60 * 1000),
        createdAt: openedAt,
      },
    });

    await prisma.caseEvent.create({
      data: {
        caseId: record.id,
        seq: 1,
        kind: "DETECTED",
        occurredAt: openedAt,
        title: "Revenue at risk detected",
        summary: `${spec.type} · ₹${spec.amountRupees.toLocaleString("en-IN")} at risk`,
        body: { type: "facts", rows: [{ label: "Amount", value: `₹${spec.amountRupees}` }] },
      },
    });

    if (spec.rootCause && spec.method) {
      await prisma.caseEvent.create({
        data: {
          caseId: record.id,
          seq: 2,
          kind: "DIAGNOSED",
          occurredAt: new Date(openedAt.getTime() + 90_000),
          title: `Diagnosed — ${spec.rootCause}`,
          summary: `confidence ${spec.confidence?.toFixed(2)} · ${
            spec.method === "RULES" ? "rules table" : "LLM"
          }`,
          badgeLabel: spec.method === "RULES" ? "method: rules-table" : "method: LLM",
          badgeTone: spec.method === "RULES" ? "neutral" : "diagnosis",
          body: {
            type: "diagnosis",
            reasoning: [],
            rows: [{ label: "Root cause", value: spec.rootCause, mono: true }],
          },
        },
      });
    }
  }

  const counts = {
    merchants: await prisma.merchant.count(),
    customers: await prisma.customer.count(),
    cases: await prisma.case.count(),
    caseEvents: await prisma.caseEvent.count(),
    policyVersions: await prisma.policyVersion.count(),
  };

  console.log(`Seeded merchant ${merchant.email} · policy ${policy.version}`);
  console.log(JSON.stringify(counts, null, 2));
  console.log(`Sign in with ${DEMO_MERCHANT.email} / ${DEMO_MERCHANT.password}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
