import { Module } from "@nestjs/common";

import { AgentCoreModule } from "../agent-core/agent-core.module";
import { CasesModule } from "../cases/cases.module";
import { IngestionController } from "./ingestion.controller";
import { IngestionService } from "./ingestion.service";
import { TwilioInboundController } from "./twilio-inbound.controller";

@Module({
  imports: [CasesModule, AgentCoreModule],
  controllers: [IngestionController, TwilioInboundController],
  providers: [IngestionService],
  exports: [IngestionService],
})
export class IngestionModule {}
