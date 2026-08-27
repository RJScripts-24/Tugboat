import { Module } from "@nestjs/common";

import { AgentCoreModule } from "../agent-core/agent-core.module";
import { ApprovalsModule } from "../approvals/approvals.module";
import { ConversationModule } from "../conversation/conversation.module";
import { IngestionModule } from "../ingestion/ingestion.module";
import { MetricsModule } from "../metrics/metrics.module";
import { PolicyModule } from "../policy/policy.module";
import { BatchRunnerService } from "./batch-runner.service";
import { SimulationsController } from "./simulations.controller";
import { SimulationsService } from "./simulations.service";

/**
 * The batch harness.
 *
 * Depends on ingestion, conversation and agent-core because it drives them
 * through their public doors. Nothing depends on it: the agent has no import
 * path into a persona, a ground truth or a seeded generator, which is what
 * makes a measurement of the batch a measurement of the product rather than of
 * a rehearsal (ADR-10).
 */
@Module({
  imports: [
    IngestionModule,
    ConversationModule,
    AgentCoreModule,
    ApprovalsModule,
    PolicyModule,
    MetricsModule,
  ],
  controllers: [SimulationsController],
  providers: [BatchRunnerService, SimulationsService],
  exports: [SimulationsService, BatchRunnerService],
})
export class SimulatorModule {}
