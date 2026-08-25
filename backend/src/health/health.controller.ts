import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";

import { Public } from "../auth/public.decorator";
import { HealthService, type HealthReport } from "./health.service";

@Controller()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /**
   * A degraded report is returned as 503 rather than 200, so a load balancer or
   * uptime ping reacts to an unreachable database instead of reading the word
   * "degraded" inside a success.
   */
  @Public()
  @Get("healthz")
  async check(): Promise<HealthReport> {
    const report = await this.health.report();

    if (report.status !== "ok") {
      throw new ServiceUnavailableException(report);
    }

    return report;
  }
}
