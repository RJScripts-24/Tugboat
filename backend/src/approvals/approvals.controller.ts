import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { IsIn, IsOptional } from "class-validator";

import type { SessionClaims } from "../auth/auth.constants";
import { CurrentMerchant } from "../auth/current-merchant.decorator";
import { ApprovalsService } from "./approvals.service";
import { ApproveApprovalDto, RejectApprovalDto } from "./dto/decide-approval.dto";

/** `?status=pending` is the only filter the page asks for; anything else is a typo. */
class ListApprovalsDto {
  @IsOptional() @IsIn(["pending", "decided"]) status?: "pending" | "decided";
}

@Controller("approvals")
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  /**
   * GET /approvals — the queue, ordered by money at risk.
   *
   * `history` rides along on the same response because the page renders both
   * tabs from one server render and a second round trip would only exist to
   * look tidy in a route table.
   */
  @Get()
  async list(@CurrentMerchant() merchant: SessionClaims, @Query() query: ListApprovalsDto) {
    if (query.status === "decided") {
      return { approvals: await this.approvals.history(merchant.sub) };
    }

    return { approvals: await this.approvals.pending(merchant.sub) };
  }

  @Get("history")
  async history(@CurrentMerchant() merchant: SessionClaims) {
    return { history: await this.approvals.history(merchant.sub) };
  }

  @Get("stats")
  async stats(@CurrentMerchant() merchant: SessionClaims) {
    return this.approvals.stats(merchant.sub);
  }

  /**
   * POST /approvals/:id/approve — a permission, not a send.
   *
   * The response says the decision was recorded and the release is queued,
   * because that is what has actually happened: the gate runs again on the
   * release, and it can still defer or refuse (D-67). Reporting "sent" here
   * would be a claim the endpoint is not in a position to make.
   */
  @Post(":id/approve")
  async approve(
    @CurrentMerchant() merchant: SessionClaims,
    @Param("id") id: string,
    @Body() body: ApproveApprovalDto,
  ) {
    const { approval, draftEdited, restarted } = await this.approvals.approve(merchant.sub, id, {
      by: merchant.name,
      draftLines: body.draftLines,
      draftSubject: body.draftSubject,
      restart: body.restart,
    });

    return { ok: true, approval, draftEdited, restarted, released: "queued" as const };
  }

  @Post(":id/reject")
  async reject(
    @CurrentMerchant() merchant: SessionClaims,
    @Param("id") id: string,
    @Body() body: RejectApprovalDto,
  ) {
    const approval = await this.approvals.reject(merchant.sub, id, {
      by: merchant.name,
      reason: body.reason,
    });

    return { ok: true, approval };
  }
}
