import { Global, Module } from "@nestjs/common";

import { ClockService } from "./clock.service";
import { DomainEventsService } from "./domain-events.service";

/**
 * Cross-cutting services every module may read without importing anything.
 *
 * Global because both of these are properties of the process rather than of a
 * subsystem: threading a `CommonModule` import through eleven modules to hand
 * each one the same singleton would be ceremony with no boundary behind it.
 *
 * The domain bus is here for a second reason. Its publishers are `cases`,
 * `approvals`, `policy` and `simulator`; its only subscriber is `realtime`.
 * Owning it from either side would be an import edge between the two, and the
 * direction of that edge is exactly what this project spends its architecture
 * tests defending.
 */
@Global()
@Module({
  providers: [ClockService, DomainEventsService],
  exports: [ClockService, DomainEventsService],
})
export class CommonModule {}
