import { Test } from "@nestjs/testing";

import { AppConfigModule } from "../config/app-config.module";
import { PrismaService } from "../prisma/prisma.service";
import { HealthService, SERVICE_NAME } from "./health.service";

async function serviceWith(databaseUp: boolean): Promise<HealthService> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppConfigModule],
    providers: [
      HealthService,
      { provide: PrismaService, useValue: { ping: async () => databaseUp } },
    ],
  }).compile();

  return moduleRef.get(HealthService);
}

describe("HealthService", () => {
  it("reports ok with the service identity when the database answers", async () => {
    const report = await (await serviceWith(true)).report();

    expect(report.status).toBe("ok");
    expect(report.service).toBe(SERVICE_NAME);
    expect(report.environment).toBe("test");
    expect(report.checks.database).toBe("up");
  });

  it("degrades when the database does not answer", async () => {
    const report = await (await serviceWith(false)).report();

    expect(report.status).toBe("degraded");
    expect(report.checks.database).toBe("down");
  });

  it("does not claim a Redis it has never contacted", async () => {
    const report = await (await serviceWith(true)).report();

    expect(["not_configured", "pending"]).toContain(report.checks.redis);
    expect(report.checks.redis).not.toBe("up");
  });

  it("defaults every outbound lane to the offline implementation", async () => {
    const report = await (await serviceWith(true)).report();

    expect(report.modes.llm).toBe("fake");
    expect(Object.values(report.modes.channels)).toEqual([
      "simulated",
      "simulated",
      "simulated",
      "simulated",
    ]);
  });
});
