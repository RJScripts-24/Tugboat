import { Injectable } from "@nestjs/common";

import { AppConfigService } from "../config/app-config.service";
import { PrismaService } from "../prisma/prisma.service";

export const SERVICE_NAME = "tugboat-api";
export const SERVICE_VERSION = "0.1.0";

/**
 * `up`/`down` are probed facts. `pending` means the dependency is configured
 * but this stage does not connect to it yet, and `not_configured` means no URL
 * has been supplied. The endpoint never reports a state it has not established.
 */
export type DependencyStatus = "up" | "down" | "pending" | "not_configured";

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
  ) {}

  async report(): Promise<HealthReport> {
    const database: DependencyStatus = (await this.prisma.ping()) ? "up" : "down";

    // BullMQ arrives in Stage 5; until then a configured URL is unverified, and
    // saying so is more useful than an optimistic "up".
    const redis: DependencyStatus = this.config.redisUrl ? "pending" : "not_configured";

    return {
      status: database === "up" ? "ok" : "degraded",
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
