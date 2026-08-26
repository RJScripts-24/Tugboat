import { Module } from "@nestjs/common";

import { AgentCoreModule } from "./agent-core/agent-core.module";
import { ApprovalsModule } from "./approvals/approvals.module";
import { AuditModule } from "./audit/audit.module";
import { AuthModule } from "./auth/auth.module";
import { CasesModule } from "./cases/cases.module";
import { ChannelsModule } from "./channels/channels.module";
import { AppConfigModule } from "./config/app-config.module";
import { ConversationModule } from "./conversation/conversation.module";
import { HealthModule } from "./health/health.module";
import { IngestionModule } from "./ingestion/ingestion.module";
import { PolicyModule } from "./policy/policy.module";
import { PrismaModule } from "./prisma/prisma.module";
import { QueueModule } from "./queue/queue.module";

/**
 * The remaining module seams land here as they are built: simulator, metrics,
 * realtime.
 */
@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    QueueModule,
    ConversationModule,
    AuthModule,
    PolicyModule,
    CasesModule,
    ChannelsModule,
    ApprovalsModule,
    AuditModule,
    AgentCoreModule,
    IngestionModule,
    HealthModule,
  ],
})
export class AppModule {}
