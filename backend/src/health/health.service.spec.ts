import { Test } from "@nestjs/testing";

import { AppConfigService } from "../config/app-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { ACTION_QUEUE } from "../queue/action-queue.interface";
import { HealthService, SERVICE_NAME } from "./health.service";

type World = { databaseUp?: boolean; redisUp?: boolean; redisUrl?: string };

/**
 * Config is stubbed rather than read from the environment: ConfigModule loads
 * `.env` once at import, so whatever REDIS_URL a developer has set would decide
 * what this spec proves.
 */
async function serviceWith({ databaseUp = true, redisUp = true, redisUrl }: World): Promise<HealthService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      HealthService,
      {
        provide: AppConfigService,
        useValue: {
          nodeEnv: "test",
          llmMode: "fake",
          redisUrl,
          channelModes: {
            email: "simulated",
            whatsapp: "simulated",
            voice: "simulated",
            razorpay: "simulated",
          },
        },
      },
      { provide: PrismaService, useValue: { ping: async () => databaseUp } },
      { provide: ACTION_QUEUE, useValue: { ping: async () => redisUp } },
    ],
  }).compile();

  return moduleRef.get(HealthService);
}

describe("HealthService", () => {
  it("reports ok with the service identity when the database answers", async () => {
    const report = await (await serviceWith({})).report();

    expect(report.status).toBe("ok");
    expect(report.service).toBe(SERVICE_NAME);
    expect(report.environment).toBe("test");
    expect(report.checks.database).toBe("up");
  });

  it("degrades when the database does not answer", async () => {
    const report = await (await serviceWith({ databaseUp: false })).report();

    expect(report.status).toBe("degraded");
    expect(report.checks.database).toBe("down");
  });

  it("does not claim a Redis it has never been given", async () => {
    const report = await (await serviceWith({ redisUrl: undefined })).report();

    expect(report.checks.redis).toBe("not_configured");
    expect(report.status).toBe("ok");
  });

  it("reports the configured broker as up only when it answered a ping", async () => {
    const report = await (await serviceWith({ redisUrl: "redis://localhost:6379" })).report();

    expect(report.checks.redis).toBe("up");
    expect(report.status).toBe("ok");
  });

  it("degrades when the configured broker does not answer", async () => {
    const report = await (
      await serviceWith({ redisUrl: "redis://localhost:6379", redisUp: false })
    ).report();

    expect(report.checks.redis).toBe("down");
    expect(report.status).toBe("degraded");
  });

  it("defaults every outbound lane to the offline implementation", async () => {
    const report = await (await serviceWith({})).report();

    expect(report.modes.llm).toBe("fake");
    expect(Object.values(report.modes.channels)).toEqual([
      "simulated",
      "simulated",
      "simulated",
      "simulated",
    ]);
  });
});
