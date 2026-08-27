import { Inject, Injectable } from "@nestjs/common";

import { AppConfigService } from "../config/app-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { ACTION_QUEUE, type ActionQueue } from "../queue/action-queue.interface";

export const SERVICE_NAME = "tugboat-api";
export const SERVICE_VERSION = "0.1.0";

/**
 * `up`/`down` are probed facts; `not_configured` means no URL has been
 * supplied, and the in-memory queue is in use. The endpoint never reports a
 * state it has not established.
 */
export type DependencyStatus = "up" | "down" | "not_configured";

export type HealthReport = {
  status: "ok" | "degraded";
  service: string;
  version: string;
  environment: string;
  uptimeSeconds: number;
  at: string;
  checks: Record<"database" | "redis", DependencyStatus>;
  modes: {
    llm: string;
    channels: Record<string, string>;
  };
};

@Injectable()
export class HealthService {
  constructor(
    private readonly config: AppConfigService,
    private readonly prisma: PrismaService,
    @Inject(ACTION_QUEUE) private readonly queue: ActionQueue,
  ) {}

  async report(): Promise<HealthReport> {
    const [databaseUp, redisUp] = await Promise.all([this.prisma.ping(), this.queue.ping()]);

    const database: DependencyStatus = databaseUp ? "up" : "down";

    // A configured broker is pinged, not assumed. Redis going away costs the
    // agent every scheduled step, and a health check that kept saying "ok"
    // through that would be the last place anybody looked (B-53).
    const redis: DependencyStatus = !this.config.redisUrl
      ? "not_configured"
      : redisUp
        ? "up"
        : "down";

    return {
      status: database === "up" && redis !== "down" ? "ok" : "degraded",
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      environment: this.config.nodeEnv,
      uptimeSeconds: Math.round(process.uptime()),
      at: new Date().toISOString(),
      checks: { database, redis },
      modes: {
        llm: this.config.llmMode,
        channels: this.config.channelModes,
      },
    };
  }
}
