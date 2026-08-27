import { Module } from "@nestjs/common";

import { ComplianceService } from "./compliance.service";
import { EvaluatorService } from "./evaluator.service";
import { ReportService } from "./report.service";

/**
 * Where the agent's own record is read back and graded.
 *
 * The only module with a query against `sim_ground_truth`, and it has no
 * dependency on `agent-core`, `policy` or `channels` — the arrow points one
 * way, from the thing being measured to the thing measuring it, and never back
 * (ADR-10). `architecture.spec.ts` asserts it.
 */
@Module({
  providers: [EvaluatorService, ComplianceService, ReportService],
  exports: [EvaluatorService, ComplianceService, ReportService],
})
export class MetricsModule {}
