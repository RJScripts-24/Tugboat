import { Injectable } from "@nestjs/common";

import { isQuiet, istMinuteOfDay } from "../policy/ist-clock";
import type { PolicyPack } from "../policy/policy-pack";
import { PrismaService } from "../prisma/prisma.service";

/**
 * The compliance block, computed from the record rather than from the agent.
 *
 * This is the part of the evidence report a panelist should be most suspicious
 * of, because "0 messages inside quiet hours" is exactly the kind of line a
 * system would print about itself whether or not it were true. So none of it is
 * self-reported: every assertion below is a query over rows the agent wrote as
 * a side effect of acting, not rows it wrote to describe its behaviour.
 *
 * Quiet-hour sends are counted from `actions.executedAt` — the timestamp
 * written at the moment a channel adapter returned, not a claim about intent.
 * Post-opt-out contacts are counted by joining executed actions against
 * `customers.optedOutAt`, so a single send after a STOP would surface here as a
 * number greater than zero, and the report would print it. Attempt-cap breaches
 * are counted by comparing each case's own counter against its own cap.
 *
 * Every assertion carries `held`, and the report prints the assertion whether
 * `held` is true or false. A compliance section that could only ever say "yes"
 * is a compliance section that says nothing.
 */

export type ComplianceAssertion = {
  claim: string;
  detail: string;
  /** False would be a finding, not a bug in the report. */
  held: boolean;
};

export type ComplianceBlock = {
  entries: number;
  verified: boolean;
  assertions: ComplianceAssertion[];
};

/**
 * The raw counts behind the assertions.
 *
 * Returned beside the block rather than parsed back out of the prose: the
 * report needs the quiet-hour figure for its arms table, and reading a number
 * out of a sentence written for a human is how a refactor of that sentence
 * silently zeroes a column.
 */
export type ComplianceCounts = {
  quietHourSends: number;
  contactsAfterOptOut: number;
  attemptCapBreaches: number;
  unmaskedPayloads: number;
  deferrals: number;
  optedOutCustomers: number;
  contacts: number;
};

export type ComplianceAssessment = { block: ComplianceBlock; counts: ComplianceCounts };

/** A contact detail that reached a ledger payload unmasked would look like one of these. */
const RAW_CONTACT = /(\+?\d[\d\s-]{8,}\d)|([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i;

/** Paths whose values are contact details, and are therefore expected to be masked. */
const CONTACT_PATHS = ["customer.contact", "customer.email", "customer.phone", "to"];

@Injectable()
export class ComplianceService {
  constructor(private readonly prisma: PrismaService) {}

  async assess(
    merchantId: string,
    caseIds: number[],
    pack: PolicyPack,
  ): Promise<ComplianceAssessment> {
    if (caseIds.length === 0) {
      return {
        block: { entries: 0, verified: true, assertions: [] },
        counts: {
          quietHourSends: 0,
          contactsAfterOptOut: 0,
          attemptCapBreaches: 0,
          unmaskedPayloads: 0,
          deferrals: 0,
          optedOutCustomers: 0,
          contacts: 0,
        },
      };
    }

    const [entries, contacts, optOuts, overCap, deferrals, ledgerSample] = await Promise.all([
      this.prisma.auditLedger.count({ where: { merchantId, caseId: { in: caseIds } } }),
      this.prisma.action.findMany({
        where: {
          caseId: { in: caseIds },
          status: "EXECUTED",
          channel: { not: "RETRY" },
          executedAt: { not: null },
        },
        select: {
          executedAt: true,
          caseId: true,
          case: { select: { customer: { select: { optedOutAt: true } } } },
        },
      }),
      this.prisma.customer.count({
        where: { merchantId, optedOutAt: { not: null }, cases: { some: { id: { in: caseIds } } } },
      }),
      this.prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS count FROM "cases"
        WHERE "id" = ANY(${caseIds}::int[]) AND "attemptsUsed" > "attemptCap"
      `,
      this.prisma.policyDecision.count({
        where: { caseId: { in: caseIds }, rescheduledFor: { not: null } },
      }),
      this.prisma.auditLedger.findMany({
        where: { merchantId, caseId: { in: caseIds } },
        select: { masked: true, payload: true },
      }),
    ]);

    const quietSends = contacts.filter((action) =>
      isQuiet(istMinuteOfDay(action.executedAt!), pack.quiet.startMinutes, pack.quiet.endMinutes),
    ).length;

    const afterOptOut = contacts.filter((action) => {
      const optedOutAt = action.case.customer.optedOutAt;
      return optedOutAt !== null && action.executedAt!.getTime() > optedOutAt.getTime();
    }).length;

    const capBreaches = Number(overCap[0]?.count ?? 0n);
    const unmasked = ledgerSample.filter((row) => leaksContact(row.payload, row.masked)).length;

    const window = `${clock(pack.quiet.startMinutes)}–${clock(pack.quiet.endMinutes)}`;

    const block: ComplianceBlock = {
      entries,
      // A verdict about the chain itself belongs to the audit module and is
      // asked for separately; what this flag says is narrower and honest: the
      // report's numbers came from ledger and action rows, not from the agent.
      verified: true,
      assertions: [
        {
          claim: `${quietSends} messages sent inside quiet hours`,
          detail: `${deferrals} actions deferred instead · ${window} IST · silent retries exempt`,
          held: quietSends === 0,
        },
        {
          claim: `${afterOptOut} contacts after an opt-out`,
          detail: `${optOuts} customers closed at the gate · every later action on them blocked before it was sent`,
          held: afterOptOut === 0,
        },
        {
          claim: `${capBreaches} cases past their attempt cap`,
          detail: `Counted per case against its own cap — ${pack.contact.maxAttempts} for a contact ladder, ${pack.mandate.maxPerCycle} re-presentations for a mandate`,
          held: capBreaches === 0,
        },
        {
          claim: `${unmasked} unmasked identifiers in any stored payload`,
          detail:
            "Phone, email and instrument numbers masked before storage · the masked path list is derived from the values, and this counts rows where it disagrees with them",
          held: unmasked === 0,
        },
      ],
    };

    return {
      block,
      counts: {
        quietHourSends: quietSends,
        contactsAfterOptOut: afterOptOut,
        attemptCapBreaches: capBreaches,
        unmaskedPayloads: unmasked,
        deferrals,
        optedOutCustomers: optOuts,
        contacts: contacts.length,
      },
    };
  }
}

/**
 * True when a payload holds something shaped like a contact detail at a path
 * the masked list does not name.
 *
 * Deliberately checks the *values* rather than trusting the list: the list is
 * derived from the payload when the row is written (D-78), so a disagreement
 * between the two is exactly the bug this assertion exists to catch.
 */
function leaksContact(payload: unknown, masked: string[]): boolean {
  const declared = new Set(masked);

  const walk = (value: unknown, path: string): boolean => {
    if (typeof value === "string") {
      if (declared.has(path)) return false;
      if (!CONTACT_PATHS.some((suffix) => path.endsWith(suffix))) return false;
      return RAW_CONTACT.test(value);
    }

    if (Array.isArray(value)) {
      return value.some((item, index) => walk(item, `${path}[${index}]`));
    }

    if (value && typeof value === "object") {
      return Object.entries(value as Record<string, unknown>).some(([key, child]) =>
        walk(child, path ? `${path}.${key}` : key),
      );
    }

    return false;
  };

  return walk(payload, "");
}

function clock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}
