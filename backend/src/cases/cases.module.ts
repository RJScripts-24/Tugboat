import { Module } from "@nestjs/common";

import { CaseStateMachine } from "../agent-core/case.state-machine";
import { PolicyModule } from "../policy/policy.module";
import { CaseEventsModule } from "./case-events.module";
import { CasesController } from "./cases.controller";
import { CasesService } from "./cases.service";

@Module({
  imports: [PolicyModule, CaseEventsModule],
  controllers: [CasesController],
  providers: [CasesService, CaseStateMachine],
  exports: [CasesService, CaseEventsModule, CaseStateMachine],
})
export class CasesModule {}
