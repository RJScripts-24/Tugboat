import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { createHash } from "node:crypto";

import { AuditWriterService } from "../audit/audit-writer.service";
import { isUniqueViolation } from "../cases/case-events.service";
import { DomainEventsService } from "../common/domain-events.service";
import { PrismaService } from "../prisma/prisma.service";
import {
  diffPacks,
  nextFreeVersion,
  renderChange,
  summariseChanges,
  type PolicyChange,
} from "./policy.diff";
import { policyPackSchema, type PolicyPack } from "./policy-pack";

export type { PolicyPack } from "./policy-pack";

export type ActivePolicy = { id: string; version: string; pack: PolicyPack };

/** Matches the frontend's PolicyRevision — the Policies page renders these rows. */
export type PolicyRevision = {
  version: string;
  hash: string;
  prevHash: string;
  actor: "HUMAN" | "SYSTEM";
  by: string;
  daysAgo: number;
  summary: string;
  changes: string[];
};

export type SaveResult = {
  version: string;
  pack: PolicyPack;
  changes: PolicyChange[];
  /** True when the submitted pack was identical to the active one, so no version was cut. */
  unchanged: boolean;
};

const GENESIS_HASH = "0".repeat(10);

/** The ledger chain policy edits are written to. One per merchant. */
const POLICY_CHAIN = "policy";

@Injectable()
export class PolicyService {
  private readonly logger = new Logger(PolicyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditWriterService,
    private readonly domain: DomainEventsService,
  ) {}

  /**
   * The pack in force, held in memory between writes.
   *
   * Every gate check, every plan and every follow-up reads this, which on a
   * two-hundred-case batch is several thousand identical queries for a row that
   * changes only when a merchant edits the policy. The cache is dropped by
   * `update` rather than expiring on a timer: a stale guardrail is the one kind
   * of stale data this system must never serve, and a version-based
   * invalidation is exact where a TTL is a guess.
   */
  private readonly activeCache = new Map<string, ActivePolicy>();

  async getActive(merchantId: string): Promise<ActivePolicy> {
    const cached = this.activeCache.get(merchantId);
    if (cached) return cached;

    const version = await this.prisma.policyVersion.findFirst({
      where: { merchantId, isActive: true },
      orderBy: { createdAt: "desc" },
    });

    if (!version) {
      throw new NotFoundException({ error: "No active policy pack for this merchant." });
    }

    const active: ActivePolicy = {
      id: version.id,
      version: version.version,
      pack: version.pack as PolicyPack,
    };

    this.activeCache.set(merchantId, active);
    return active;
  }

  /** Called wherever the active version changes, so the next read goes to the row. */
  invalidateActive(merchantId: string): void {
    this.activeCache.delete(merchantId);
  }

  /**
   * Every version ever cut, newest first, hash-chained.
   *
   * The chain is derived on read from `(version, changes, previous hash)` using
   * the same construction the browser uses, so the page can verify the history
   * itself rather than being told it is intact. `PolicyVersion.hash` is left to
   * do its own job — identifying the pack's contents.
   */
  async revisions(merchantId: string): Promise<PolicyRevision[]> {
    const rows = await this.prisma.policyVersion.findMany({
      where: { merchantId },
      orderBy: { createdAt: "asc" },
    });

    const now = Date.now();
    const chained: PolicyRevision[] = [];
    let prevHash = GENESIS_HASH;

    for (const row of rows) {
      const hash = chainHash(row.version, row.changes, prevHash);
      chained.push({
        version: row.version,
        hash,
        prevHash,
        actor: row.createdBy ? "HUMAN" : "SYSTEM",
        by: row.createdBy ?? "Tugboat",
        daysAgo: Math.max(0, Math.round((now - row.createdAt.getTime()) / 86_400_000)),
        summary: row.note ?? summariseChanges([]),
        changes: row.changes,
      });
      prevHash = hash;
    }

    return chained.reverse();
  }

  /**
   * Validates a submitted pack, diffs it against what is in force, and cuts a
   * new version if anything moved.
   *
   * The write is versioned rather than in-place (ADR-12) because every policy
   * decision points at the exact version it was checked against: editing the
   * active row would silently rewrite the rules that governed decisions already
   * taken, and the evidence report's "under policy v4" line would stop being
   * true retrospectively.
   */
  async save(merchantId: string, input: unknown, actor: string): Promise<SaveResult> {
    const pack = this.parsePack(input);
    const active = await this.getActive(merchantId);
    const changes = diffPacks(active.pack, pack);

    if (changes.length === 0) {
      return { version: active.version, pack: active.pack, changes: [], unchanged: true };
    }

    const created = await this.withVersionRetry(merchantId, async (version) =>
      this.prisma.transaction(async (tx) => {
        await tx.policyVersion.updateMany({
          where: { merchantId, isActive: true },
          data: { isActive: false },
        });

        const row = await tx.policyVersion.create({
          data: {
            merchantId,
            version,
            pack,
            hash: packHash(pack),
            note: summariseChanges(changes),
            changes: changes.map(renderChange),
            isActive: true,
            createdBy: actor,
          },
        });

        // The rules get their own chain, in the same write that cuts the
        // version. "Who changed the rules" belongs beside "what the rules
        // stopped", and a policy edit that the ledger did not witness would
        // leave every decision taken afterwards pointing at a version whose
        // arrival is unexplained.
        await this.audit.append(tx, {
          merchantId,
          chain: POLICY_CHAIN,
          actor: "HUMAN",
          action: "POLICY_CHANGED",
          detail: `${active.version} → ${version} · ${summariseChanges(changes)}`,
          at: row.createdAt,
          payload: {
            version,
            previous_version: active.version,
            changed_by: actor,
            changes: changes.map(renderChange),
            fields: changes.length,
            pack_hash: row.hash,
          },
        });

        return row;
      }),
    );

    // Before the log line and before the caller returns: the next gate check
    // must read the pack that was just cut, not the one it replaced.
    this.invalidateActive(merchantId);

    this.logger.log(
      `Policy ${active.version} → ${created.version} by ${actor} · ${changes
        .map(renderChange)
        .join(" · ")}`,
    );

    // Every open Control Tower is printing the old version in its top bar and
    // beside every bound on the Policies page. This is the one event the
    // gateway forwards that changes what a *rule* says rather than what a case
    // did, so it goes to every page rather than to the dashboard's own room.
    this.domain.publish({ name: "policy.changed", merchantId, version: created.version });

    return { version: created.version, pack, changes, unchanged: false };
  }

  private parsePack(input: unknown): PolicyPack {
    // Checked ahead of the schema purely so the refusal says why. The schema
    // types `opt_out` as the literal `true`, which is what actually makes the
    // rule impossible to switch off (PRD 9.4).
    if (isOptOutDisabled(input)) {
      throw new UnprocessableEntityException({
        error:
          "Opt-out cannot be disabled. A customer who sent STOP is closed on every channel, permanently — this is the one rule with no switch.",
      });
    }

    const parsed = policyPackSchema.safeParse(input);
    if (!parsed.success) {
      throw new UnprocessableEntityException({
        error: "The submitted policy pack is not valid.",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }

    return parsed.data;
  }

  /**
   * Two concurrent saves both compute the same next label; the unique
   * constraint on (merchantId, version) turns that race into a caught error
   * rather than two rows claiming to be v5, and the loser recomputes.
   *
   * The label comes from the highest version *ever cut*, not from the one in
   * force. They are normally the same number, and assuming so made the retry a
   * no-op: on a merchant whose active pack was not its newest, every attempt
   * recomputed the identical taken label and the third one threw (B-24).
   */
  private async withVersionRetry<T>(
    merchantId: string,
    run: (version: string) => Promise<T>,
    attempts = 3,
  ): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      const taken = await this.prisma.policyVersion.findMany({
        where: { merchantId },
        select: { version: true },
      });

      try {
        return await run(nextFreeVersion(taken.map((row) => row.version)));
      } catch (error) {
        if (attempt >= attempts || !isUniqueViolation(error)) throw error;
        this.logger.warn(`Policy version collision; retrying (attempt ${attempt + 1})`);
      }
    }
  }
}

function isOptOutDisabled(input: unknown): boolean {
  if (typeof input !== "object" || input === null) return false;
  const rules = (input as { rules?: unknown }).rules;
  if (typeof rules !== "object" || rules === null) return false;
  return (rules as { opt_out?: unknown }).opt_out === false;
}

/** Identifies the pack's contents. Key order is fixed by the schema, so it is stable. */
export function packHash(pack: PolicyPack): string {
  return createHash("sha256").update(JSON.stringify(pack)).digest("hex").slice(0, 16);
}

/** FNV-1a widened to a hex digest — the same construction `ledger-verify.ts` recomputes. */
export function chainHash(version: string, changes: string[], prevHash: string): string {
  const text = `${version}|${changes.join(",")}|${prevHash}`;
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let out = "";
  while (out.length < 10) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    out += (h >>> 0).toString(16).padStart(8, "0");
  }
  return out.slice(0, 10);
}
