import { Controller, Get, NotFoundException, Param, Query } from "@nestjs/common";

import type { SessionClaims } from "../auth/auth.constants";
import { CurrentMerchant } from "../auth/current-merchant.decorator";
import { parseCaseRef, toCaseRef } from "../common/case-ref";
import { PolicyService } from "../policy/policy.service";
import { CasesService } from "./cases.service";
import {
  toBounds,
  toCustomerProfile,
  toOrigin,
  toOutcome,
  toPipelineCase,
  toTimelineEvent,
} from "./cases.mapper";
import { ListCasesDto } from "./dto/list-cases.dto";

@Controller("cases")
export class CasesController {
  constructor(
    private readonly cases: CasesService,
    private readonly policy: PolicyService,
  ) {}

  /** GET /cases — the Recovery Pipeline's list. */
  @Get()
  async list(@CurrentMerchant() merchant: SessionClaims, @Query() query: ListCasesDto) {
    const { rows, total } = await this.cases.list(merchant.sub, {
      stage: query.stage,
      type: query.type,
      rootCause: query.cause,
      search: query.search,
      minPaise: query.minPaise,
      maxPaise: query.maxPaise,
      skip: query.skip,
      take: query.take,
    });

    return { cases: rows.map(toPipelineCase), total };
  }

  /**
   * GET /cases/:id — Case Detail.
   *
   * `pending` and `audit` are still empty, and honestly so. Scheduled work now
   * exists as `actions` rows carrying a `scheduledFor`, but projecting it into
   * the timeline's shape belongs with the frontend wiring in Stage 9; ledger
   * rows do not exist at all until the audit module lands in Stage 7. An
   * invented placeholder in either would be worse than an empty list.
   */
  @Get(":id")
  async detail(@CurrentMerchant() merchant: SessionClaims, @Param("id") id: string) {
    const caseId = parseCaseRef(id);
    if (caseId === null) {
      throw new NotFoundException({ error: `"${id}" is not a case reference.` });
    }

    const record = await this.cases.findOne(merchant.sub, caseId);
    const policy = await this.policy.getActive(merchant.sub);
    const neighbours = await this.cases.neighbours(merchant.sub, caseId);

    const channelUsage: Record<string, number> = {};
    for (const action of record.actions) {
      if (action.channel) {
        channelUsage[action.channel] = (channelUsage[action.channel] ?? 0) + 1;
      }
    }

    return {
      record: toPipelineCase(record),
      customer: toCustomerProfile(record.customer),
      origin: toOrigin(record),
      openedMinutesAgo: Math.max(
        0,
        Math.round((Date.now() - record.createdAt.getTime()) / 60_000),
      ),
      deadlineLabel: record.deadlineAt
        ? record.deadlineAt.toISOString().slice(0, 10)
        : "No deadline",
      bounds: toBounds(record, record.customer, policy, channelUsage),
      events: record.events.map(toTimelineEvent),
      pending: [],
      outcome: toOutcome(record, {
        contacts: record.actions.filter((action) => action.channel !== "RETRY").length,
        llmCalls: 0,
        llmTokens: 0,
      }),
      audit: [],
      neighbours: {
        prev: neighbours.prev ? toCaseRef(neighbours.prev) : null,
        next: neighbours.next ? toCaseRef(neighbours.next) : null,
      },
    };
  }
}
