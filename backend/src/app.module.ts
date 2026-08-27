import { Module } from "@nestjs/common";

import { AgentCoreModule } from "./agent-core/agent-core.module";
import { ApprovalsModule } from "./approvals/approvals.module";
import { AuditModule } from "./audit/audit.module";
import { AuthModule } from "./auth/auth.module";
import { CasesModule } from "./cases/cases.module";
import { CommonModule } from "./common/common.module";
import { ChannelsModule } from "./channels/channels.module";
import { AppConfigModule } from "./config/app-config.module";
import { ConversationModule } from "./conversation/conversation.module";
import { DashboardModule } from "./dashboard/dashboard.module";
import { HealthModule } from "./health/health.module";
import { IngestionModule } from "./ingestion/ingestion.module";
import { MetricsModule } from "./metrics/metrics.module";
import { PolicyModule } from "./policy/policy.module";
import { PrismaModule } from "./prisma/prisma.module";
import { QueueModule } from "./queue/queue.module";
import { RealtimeModule } from "./realtime/realtime.module";
import { SimulatorModule } from "./simulator/simulator.module";

/**
 * Eleven modules and one rule about their edges: the arrows point from the
 * thing being measured toward the thing measuring it, never back. `metrics`
 * reads the agent; `realtime` reads the bus; neither is reachable from the code
 * that writes a case.
 */
@Module({
  imports: [
    AppConfigModule,
    CommonModule,
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
    MetricsModule,
    SimulatorModule,
    DashboardModule,
    RealtimeModule,
    HealthModule,
  ],
})
export class AppModule {}
