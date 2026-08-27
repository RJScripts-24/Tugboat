import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@prisma/client";

import { DomainEventsService } from "../common/domain-events.service";
import { AppConfigService } from "../config/app-config.service";

/**
 * Connections the driver pool may hold open.
 *
 * `pg` defaults to ten, which is fine for request traffic and not fine for a
 * simulation run: the batch works a dozen independent cases at once and every
 * one of them opens a transaction, so at the default the eleventh waits for a
 * slot and eventually fails with "unable to start a transaction in the given
 * time" — which reads like a database problem and is a pool-size problem
 * (B-26). Comfortably inside Neon's pooled limit.
 */
const POOL_SIZE = 20;

/**
 * How long an interactive transaction may run, and how long it may wait for a
 * connection.
 *
 * Prisma's defaults are five seconds and two. Both are generous against a
 * database on the same machine and tight against one across an ocean: a case
 * event, its ledger row and the state change they describe are five round trips
 * inside one transaction, and at 250ms a trip a dozen of those running at once
 * will occasionally cross five seconds — which fails with "a query cannot be
 * executed on an expired transaction" and takes a whole simulation run with it
 * (B-27). The work inside a transaction did not grow; the distance did.
 */
const TRANSACTION_TIMEOUT_MS = 20_000;
const TRANSACTION_MAX_WAIT_MS = 15_000;

/**
 * Prisma 7 has no bundled query engine — it drives a real node-postgres pool
 * through a driver adapter. The pooled Neon endpoint is used here; migrations
 * run separately against the direct endpoint via prisma.config.ts.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(
    config: AppConfigService,
    private readonly events: DomainEventsService,
  ) {
    super({
      adapter: new PrismaPg({ connectionString: config.databaseUrl, max: POOL_SIZE }),
      transactionOptions: {
        timeout: TRANSACTION_TIMEOUT_MS,
        maxWait: TRANSACTION_MAX_WAIT_MS,
      },
      log: ["warn", "error"],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log("Connected to Postgres");
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * An interactive transaction whose domain events are announced on commit.
   *
   * Identical to `$transaction` in everything a caller can see, and different
   * in the one thing a caller cannot: anything published to the domain bus
   * inside `run` is held until the transaction resolves, and dropped if it
   * throws (D-100). Every writer that a socket listener cares about goes through
   * here rather than through `$transaction` directly, which is what makes "the
   * Control Tower never shows a state the database rolled back" a property of
   * the seam rather than of every author who ever adds an emit.
   */
  transaction<T>(run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.events.collect(() => this.$transaction(run));
  }

  /** Round-trips a trivial query so callers can distinguish reachable from configured. */
  async ping(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch (error) {
      this.logger.error(`Database ping failed: ${(error as Error).message}`);
      return false;
    }
  }
}
