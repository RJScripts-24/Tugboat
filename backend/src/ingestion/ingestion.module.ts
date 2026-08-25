import { Module } from "@nestjs/common";

import { AgentCoreModule } from "../agent-core/agent-core.module";
import { CasesModule } from "../cases/cases.module";
import { IngestionController } from "./ingestion.controller";
import { IngestionService } from "./ingestion.service";

@Module({
  imports: [CasesModule, AgentCoreModule],
  controllers: [IngestionController],
  providers: [IngestionService],
  exports: [IngestionService],
})
export class IngestionModule {}
