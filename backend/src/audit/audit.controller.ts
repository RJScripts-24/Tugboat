import { Body, Controller, Get, HttpCode, NotFoundException, Post, Query } from "@nestjs/common";

import type { SessionClaims } from "../auth/auth.constants";
import { CurrentMerchant } from "../auth/current-merchant.decorator";
import { parseCaseRef } from "../common/case-ref";
import { AuditService } from "./audit.service";
import { ListAuditDto, VerifyChainDto } from "./dto/list-audit.dto";

@Controller("audit")
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  /** GET /audit — the ledger, newest first, already masked. */
  @Get()
  async list(@CurrentMerchant() merchant: SessionClaims, @Query() query: ListAuditDto) {
    let caseId: number | undefined;

    if (query.case) {
      const parsed = parseCaseRef(query.case);
      if (parsed === null) {
        throw new NotFoundException({
          error: `"${query.case}" is not a case reference.`,
          message: `"${query.case}" is not a case reference.`,
        });
      }
      caseId = parsed;
    }

    const { rows, total } = await this.audit.list(merchant.sub, {
      caseId,
      chain: query.chain,
      actor: query.actor,
      action: query.action,
      fromMs: query.fromMs,
      toMs: query.toMs,
      skip: query.skip,
      take: query.take,
    });

    return { rows, total, tips: await this.audit.tips(merchant.sub) };
  }

  @Get("summary")
  async summary(@CurrentMerchant() merchant: SessionClaims) {
    return this.audit.summary(merchant.sub);
  }

  /**
   * POST /audit/verify-chain — the same answer without a browser.
   *
   * A POST rather than a GET because it is a job rather than a lookup: it reads
   * every row of every chain and recomputes each digest. It reads and writes
   * nothing, so the 200 is explicit — a verification that mutated the thing it
   * verifies would be a contradiction.
   */
  @Post("verify-chain")
  @HttpCode(200)
  async verify(@CurrentMerchant() merchant: SessionClaims, @Body() body: VerifyChainDto) {
    return this.audit.verify(merchant.sub, { chain: body.chain });
  }
}
