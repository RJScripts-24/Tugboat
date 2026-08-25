import { Module } from "@nestjs/common";

import { ApprovalsModule } from "../approvals/approvals.module";
import { ChannelsModule } from "../channels/channels.module";
import { CasesModule } from "../cases/cases.module";
import { PolicyModule } from "../policy/policy.module";
import { AgentWorker } from "./agent-worker";
import { CaseStateMachine } from "./case.state-machine";
import { DetectorService } from "./detector.service";
import { DiagnoserService } from "./diagnoser.service";
import { ExecutorService } from "./executor.service";
import { PlannerService } from "./planner.service";

/**
 * The five-stage pipeline as separate injectable services (ADR-4).
 * Detector and Diagnoser landed in Stage 3; Planner and Executor in Stage 5;
 * the Evaluator follows in Stage 8.
 */
@Module({
  imports: [CasesModule, PolicyModule, ChannelsModule, ApprovalsModule],
  providers: [
    CaseStateMachine,
    DetectorService,
    DiagnoserService,
    PlannerService,
    ExecutorService,
    AgentWorker,
  ],
  exports: [CaseStateMachine, DetectorService, DiagnoserService, PlannerService, ExecutorService],
})
export class AgentCoreModule {}
