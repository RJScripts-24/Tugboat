import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module";
import { CaseEventsService } from "./case-events.service";

/**
 * The event writer on its own, because both `CasesModule` and `PolicyModule`
 * need it and `CasesModule` already depends on `PolicyModule`. Extracting the
 * shared leaf is how that dependency stays a tree instead of becoming a cycle
 * held together by `forwardRef`.
 */
@Module({
  imports: [AuditModule],
  providers: [CaseEventsService],
  exports: [CaseEventsService],
})
export class CaseEventsModule {}
