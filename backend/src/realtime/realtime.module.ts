import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";

import { DashboardModule } from "../dashboard/dashboard.module";
import { RealtimeGateway } from "./realtime.gateway";

/**
 * A leaf, on purpose.
 *
 * Nothing imports `realtime`. It reaches the rest of the system through the
 * domain bus in `common`, which every publisher can reach without knowing a
 * socket exists — so the day this module is deleted, or replaced with SSE, or
 * pointed at a message broker, no service that writes a case event changes a
 * line. The one module it does import is `dashboard`, and only to answer the
 * `kpi.updated` nudge with real numbers; that dependency points at a read-only
 * module, which is the safe direction for it to point.
 */
@Module({
  imports: [JwtModule.register({}), DashboardModule],
  providers: [RealtimeGateway],
})
export class RealtimeModule {}
