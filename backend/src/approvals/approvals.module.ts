import { Module } from "@nestjs/common";

import { CasesModule } from "../cases/cases.module";
import { PolicyModule } from "../policy/policy.module";
import { ApprovalsController } from "./approvals.controller";
import { ApprovalsService } from "./approvals.service";

/**
 * Human-in-the-loop, and deliberately ignorant of the agent.
 *
 * This module knows how to write a request, read the queue and record a
 * decision. It does not know how to send anything — approving enqueues a
 * release that `agent-core` picks up. The dependency therefore points one way
 * (agent-core → approvals) with the queue closing the loop, which is what keeps
 * the two out of a `forwardRef` and keeps "nothing reaches a customer except
 * through the Executor" true.
 */
@Module({
  imports: [CasesModule, PolicyModule],
  controllers: [ApprovalsController],
  providers: [ApprovalsService],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
