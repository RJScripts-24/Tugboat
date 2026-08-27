import { Module } from "@nestjs/common";

import { PolicyModule } from "../policy/policy.module";
import { DashboardController } from "./dashboard.controller";
import { DashboardService } from "./dashboard.service";

/**
 * A read-only module, and deliberately a leaf.
 *
 * It imports the policy pack (for the version the shell prints) and nothing
 * else: no agent module, no queue, no channel. Anything it could reach, it
 * could accidentally change, and a dashboard that can write is a dashboard
 * that can disagree with the ledger it is summarising.
 */
@Module({
  imports: [PolicyModule],
  controllers: [DashboardController],
  providers: [DashboardService],
  exports: [DashboardService],
})
export class DashboardModule {}
