import { Module } from "@nestjs/common";

import { CaseEventsModule } from "../cases/case-events.module";
import { PolicyController } from "./policy.controller";
import { PolicyGateService } from "./policy-gate.service";
import { PolicyService } from "./policy.service";

/**
 * The gate lives beside the policy it enforces, so the pack and the code that
 * reads it cannot drift into separate modules with separate ideas of the rules.
 */
@Module({
  imports: [CaseEventsModule],
  controllers: [PolicyController],
  providers: [PolicyService, PolicyGateService],
  exports: [PolicyService, PolicyGateService],
})
export class PolicyModule {}
