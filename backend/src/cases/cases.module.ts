import { Module } from "@nestjs/common";

import { CaseStateMachine } from "../agent-core/case.state-machine";
import { AuditModule } from "../audit/audit.module";
import { PolicyModule } from "../policy/policy.module";
import { CaseEventsModule } from "./case-events.module";
import { CasesController } from "./cases.controller";
import { CaseOverridesService } from "./case-overrides.service";
import { CasesService } from "./cases.service";

@Module({
  imports: [PolicyModule, CaseEventsModule, AuditModule],
  controllers: [CasesController],
  providers: [CasesService, CaseOverridesService, CaseStateMachine],
  exports: [CasesService, CaseOverridesService, CaseEventsModule, CaseStateMachine],
})
export class CasesModule {}
