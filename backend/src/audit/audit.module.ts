import { Module } from "@nestjs/common";

import { AuditController } from "./audit.controller";
import { AuditService } from "./audit.service";
import { AuditWriterService } from "./audit-writer.service";

/**
 * A leaf, on purpose.
 *
 * The writer is called from inside the transaction that records a case event,
 * so every module that writes history depends on this one. It therefore has to
 * depend on nothing but Prisma — a single import pointing the other way would
 * turn the whole graph into a cycle, and the ledger is the last place to want
 * a `forwardRef`.
 */
@Module({
  controllers: [AuditController],
  providers: [AuditService, AuditWriterService],
  exports: [AuditWriterService, AuditService],
})
export class AuditModule {}
