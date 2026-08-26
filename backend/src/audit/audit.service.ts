import { Injectable } from "@nestjs/common";
import type { AuditLedger, LedgerActor, Prisma } from "@prisma/client";

import { toCaseRef } from "../common/case-ref";
import { PrismaService } from "../prisma/prisma.service";
import { GENESIS_HASH } from "./ledger-digest";
import type { PayloadValue } from "./ledger-seed";
import { chainsOf, rowId, verifyChainRows, type VerifiableRow } from "./verify-chain";

/**
 * Reading the ledger, and checking it.
 *
 * The server-side verification here is deliberately *not* the important one.
 * A server that writes the hashes and then reports them verified has proved
 * nothing — the check that matters is the one the browser runs on the rows it
 * was handed (`frontend/src/lib/ledger-verify.ts`), from the same inputs. This
 * endpoint exists so the same answer is available without a browser, and so a
 * batch of ten thousand rows can be checked without shipping them; it does one
 * thing the browser cannot, which is rebuild each row's preimage from the
 * columns rather than trusting the stored string (D-74).
 */

/** Matches the frontend's `LedgerRow` field for field. */
export type LedgerRowView = {
  id: string;
  chain: string;
  seq: number;
  hash: string;
  prevHash: string;
  seed: string;
  actor: LedgerActor;
  action: string;
  atMs: number;
  detail: string;
  caseId: string | null;
  masked: string[];
  payload: PayloadValue;
};

/** Matches the frontend's `ChainVerdict`, plus what was checked with what. */
export type ChainVerdictView = {
  checked: number;
  chains: number;
  broken: { id: string; chain: string; seq: number; reason: string }[];
  digests: { browser: string; server: string };
};

export type AuditFilters = {
  caseId?: number;
  chain?: string;
  actor?: LedgerActor[];
  action?: string[];
  fromMs?: number;
  toMs?: number;
  skip?: number;
  take?: number;
};

const DIGESTS = { browser: "fnv1a-32/10hex", server: "sha256" };

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * `GET /audit` — newest first, which is the reading order of a log.
   *
   * A chain's rows never invert inside a timestamp tie: a digest that covers
   * the row before it must appear after the row before it, or the page renders
   * a chain that looks broken when it is not.
   */
  async list(merchantId: string, filters: AuditFilters = {}) {
    const where = this.whereFor(merchantId, filters);

    const [rows, total] = await Promise.all([
      this.prisma.auditLedger.findMany({
        where,
        orderBy: [{ at: "desc" }, { chain: "asc" }, { seq: "desc" }],
        skip: filters.skip ?? 0,
        take: filters.take ?? 200,
      }),
      this.prisma.auditLedger.count({ where }),
    ]);

    return { rows: rows.map(toLedgerRow), total };
  }

  /** The tip of each chain, so an appended row continues the log rather than starting a second one. */
  async tips(merchantId: string): Promise<Record<string, { hash: string; seq: number }>> {
    const rows = await this.prisma.auditLedger.findMany({
      where: { merchantId },
      orderBy: { seq: "asc" },
      select: { chain: true, seq: true, hash: true },
    });

    const tips: Record<string, { hash: string; seq: number }> = {};
    for (const row of rows) {
      const tip = tips[row.chain];
      if (!tip || row.seq > tip.seq) tips[row.chain] = { hash: row.hash, seq: row.seq };
    }

    return tips;
  }

  async summary(merchantId: string) {
    const [entries, chains, actors] = await Promise.all([
      this.prisma.auditLedger.count({ where: { merchantId } }),
      this.prisma.auditLedger.findMany({
        where: { merchantId },
        distinct: ["chain"],
        select: { chain: true },
      }),
      this.prisma.auditLedger.groupBy({
        by: ["actor"],
        where: { merchantId },
        _count: { _all: true },
      }),
    ]);

    const byActor: Record<LedgerActor, number> = { BOA: 0, POLICY: 0, HUMAN: 0, SYSTEM: 0 };
    for (const row of actors) byActor[row.actor] = row._count._all;

    return { entries, chains: chains.length, byActor };
  }

  /**
   * `POST /audit/verify-chain` — every chain, or one of them.
   *
   * Three things can be wrong with a row, and they are reported as three
   * different findings because they mean three different things:
   *
   * - its **preimage** no longer describes it (someone edited the payload or a
   *   field and left the seed alone);
   * - its **link** disagrees with the row before it (a row was removed or
   *   reordered);
   * - its **digest** does not match its preimage (the row was rewritten).
   *
   * Each row is chained from the digest this pass just recomputed, never from
   * the one stored beside it. Verifying against the stored value would let a
   * chain of forged rows verify perfectly — every row would agree with the
   * neighbour it names, and nothing would ever be checked against the payloads
   * underneath.
   */
  async verify(merchantId: string, options: { chain?: string } = {}): Promise<ChainVerdictView> {
    const rows = await this.prisma.auditLedger.findMany({
      where: { merchantId, ...(options.chain ? { chain: options.chain } : {}) },
      orderBy: [{ chain: "asc" }, { seq: "asc" }],
    });

    const byChain = chainsOf(rows.map(toVerifiable));

    const broken: ChainVerdictView["broken"] = [];
    for (const [chain, chainRows] of byChain) {
      broken.push(...verifyChainRows(chain, chainRows));
    }

    return { checked: rows.length, chains: byChain.size, broken, digests: DIGESTS };
  }

  private whereFor(merchantId: string, filters: AuditFilters): Prisma.AuditLedgerWhereInput {
    return {
      merchantId,
      ...(filters.caseId !== undefined ? { caseId: filters.caseId } : {}),
      ...(filters.chain ? { chain: filters.chain } : {}),
      ...(filters.actor?.length ? { actor: { in: filters.actor } } : {}),
      ...(filters.action?.length ? { action: { in: filters.action } } : {}),
      ...(filters.fromMs !== undefined || filters.toMs !== undefined
        ? {
            at: {
              ...(filters.fromMs !== undefined ? { gte: new Date(filters.fromMs) } : {}),
              ...(filters.toMs !== undefined ? { lte: new Date(filters.toMs) } : {}),
            },
          }
        : {}),
    };
  }
}

/** The verifier takes plain rows, so it can run without Prisma or a database. */
function toVerifiable(row: AuditLedger): VerifiableRow {
  return {
    chain: row.chain,
    seq: row.seq,
    hash: row.hash,
    prevHash: row.prevHash,
    sha256: row.sha256,
    prevSha256: row.prevSha256,
    seed: row.seed,
    actor: row.actor,
    action: row.action,
    at: row.at,
    detail: row.detail,
    caseRef: row.caseId != null ? toCaseRef(row.caseId) : null,
    payload: row.payload as PayloadValue,
  };
}

export function toLedgerRow(row: AuditLedger): LedgerRowView {
  return {
    id: rowId(row),
    chain: row.chain,
    seq: row.seq,
    hash: row.hash,
    prevHash: row.prevHash,
    seed: row.seed,
    actor: row.actor,
    action: row.action,
    atMs: row.at.getTime(),
    detail: row.detail,
    caseId: row.caseId != null ? toCaseRef(row.caseId) : null,
    masked: row.masked,
    payload: row.payload as PayloadValue,
  };
}

export { GENESIS_HASH };
