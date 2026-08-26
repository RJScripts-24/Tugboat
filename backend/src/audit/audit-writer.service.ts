import { Injectable } from "@nestjs/common";
import type { LedgerActor, Prisma } from "@prisma/client";

import { toCaseRef } from "../common/case-ref";

import { GENESIS_HASH, GENESIS_SHA256, chainHash, chainSha256 } from "./ledger-digest";
import { buildSeed, maskedPathsIn, type PayloadValue } from "./ledger-seed";

/**
 * The only way a row reaches the ledger.
 *
 * `AuditWriter` is not subscribed to domain events — it *is* part of writing
 * them. `CaseEventsService.append` calls this inside the same transaction that
 * records the event, so a case's history and its evidence are one write: there
 * is no code path that can add to the story without adding to the log, and no
 * window in which a crash leaves one without the other (D-75).
 *
 * Every append takes the caller's transaction client for that reason. There is
 * no overload that accepts the bare client, so a caller who wanted to write a
 * ledger row on its own could not.
 */

export type AppendLedgerInput = {
  merchantId: string;
  /** A case reference ("C-1195") or "policy". */
  chain: string;
  actor: LedgerActor;
  action: string;
  detail: string;
  caseId?: number | null;
  payload: PayloadValue;
  at?: Date;
};

@Injectable()
export class AuditWriterService {
  /**
   * Appends one row to the end of its chain.
   *
   * The sequence and the previous digest are read inside the caller's
   * transaction, so two writers racing on one chain cannot both believe they
   * are row seven — the unique index on (merchantId, chain, seq) turns that
   * into a loud failure, and `withSeqRetry` at the call site retries the loser.
   * A silently reordered chain would be far worse than a caught error: every
   * row after the collision would verify against the wrong link.
   */
  async append(tx: Prisma.TransactionClient, input: AppendLedgerInput) {
    const at = input.at ?? new Date();

    const previous = await tx.auditLedger.findFirst({
      where: { merchantId: input.merchantId, chain: input.chain },
      orderBy: { seq: "desc" },
      select: { seq: true, hash: true, sha256: true },
    });

    const seq = (previous?.seq ?? 0) + 1;
    const prevHash = previous?.hash ?? GENESIS_HASH;
    const prevSha256 = previous?.sha256 || GENESIS_SHA256;

    // The wire shape carries the case reference, not the integer id, so the
    // seed covers the same string the browser is asked to hash.
    const caseRef = input.caseId != null ? toCaseRef(input.caseId) : null;

    const seed = buildSeed({
      chain: input.chain,
      seq,
      atMs: at.getTime(),
      actor: input.actor,
      action: input.action,
      caseId: caseRef,
      detail: input.detail,
      payload: input.payload,
    });

    return tx.auditLedger.create({
      data: {
        merchantId: input.merchantId,
        chain: input.chain,
        seq,
        hash: chainHash(seed, prevHash),
        prevHash,
        sha256: chainSha256(seed, prevSha256),
        prevSha256,
        seed,
        actor: input.actor,
        action: input.action,
        at,
        detail: input.detail,
        caseId: input.caseId ?? null,
        // Derived from the values rather than declared, so the list cannot fall
        // out of step with what the payload actually holds.
        masked: maskedPathsIn(input.payload),
        payload: input.payload as unknown as Prisma.InputJsonValue,
      },
    });
  }
}
