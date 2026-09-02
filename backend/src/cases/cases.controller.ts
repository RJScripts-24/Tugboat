import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
} from "@nestjs/common";

import { AuditService } from "../audit/audit.service";
import type { SessionClaims } from "../auth/auth.constants";
import { CurrentMerchant } from "../auth/current-merchant.decorator";
import { parseCaseRef, toCaseRef } from "../common/case-ref";
import { ClockService } from "../common/clock.service";
import { WAIVABLE_CHECKS } from "../policy/policy-gate.evaluate";
import { PolicyGateService } from "../policy/policy-gate.service";
import { PolicyService } from "../policy/policy.service";
import { CaseOverridesService } from "./case-overrides.service";
import { CasesService } from "./cases.service";
import {
  toBounds,
  toCustomerProfile,
  toOrigin,
  toOutcome,
  toPendingEvent,
  toPipelineCase,
  toTimelineEvent,
} from "./cases.mapper";
import { ListCasesDto } from "./dto/list-cases.dto";
import { OverrideCaseDto } from "./dto/override-case.dto";

@Controller("cases")
export class CasesController {
  constructor(
    private readonly cases: CasesService,
    private readonly overrides: CaseOverridesService,
    private readonly policy: PolicyService,
    private readonly gate: PolicyGateService,
    private readonly audit: AuditService,
    private readonly clock: ClockService,
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
   * GET /cases/:id — Case Detail, whole.
   *
   * Every list on this response is now real. `pending` is the case's scheduled
   * `actions` rows projected into the timeline's own shape — work that has been
   * decided and not yet done, which is what makes the timeline readable as a
   * plan rather than only as a history. `audit` is this case's own ledger
   * chain, so the digests beside the timeline and the digests in the Audit
   * Explorer are the same ten characters rather than two computations that
   * agree most of the time.
   */
  @Get(":id")
  async detail(@CurrentMerchant() merchant: SessionClaims, @Param("id") id: string) {
    const caseId = this.parse(id);

    const record = await this.cases.findOne(merchant.sub, caseId);
    const [policy, neighbours, ledger, llm, batchSize] = await Promise.all([
      this.policy.getActive(merchant.sub),
      this.cases.neighbours(merchant.sub, caseId),
      this.audit.forCase(merchant.sub, caseId),
      this.cases.inferenceSpend(caseId),
      this.cases.count(merchant.sub),
    ]);

    const channelUsage: Record<string, number> = {};
    for (const action of record.actions) {
      if (action.channel) {
        channelUsage[action.channel] = (channelUsage[action.channel] ?? 0) + 1;
      }
    }

    const nowMs = this.clock.nowMs();

    return {
      record: toPipelineCase(record),
      customer: toCustomerProfile(record.customer),
      origin: toOrigin(record),
      openedMinutesAgo: Math.max(0, Math.round((nowMs - record.createdAt.getTime()) / 60_000)),
      deadlineLabel: record.deadlineAt
        ? record.deadlineAt.toISOString().slice(0, 10)
        : "No deadline",
      bounds: toBounds(record, record.customer, policy, channelUsage),
      events: record.events.map(toTimelineEvent),
      pending: record.actions
        .filter((action) => action.status === "PLANNED" && action.scheduledFor !== null)
        .map((action, index) => toPendingEvent(action, record.events.length + index + 1)),
      outcome: toOutcome(record, {
        contacts: record.actions.filter((action) => action.channel !== "RETRY").length,
        llmCalls: llm.calls,
        llmTokens: llm.tokens,
      }),
      audit: ledger,
      neighbours: {
        prev: neighbours.prev ? toCaseRef(neighbours.prev) : null,
        next: neighbours.next ? toCaseRef(neighbours.next) : null,
      },
      /** Set while a merchant has the case; the browser folds it the same way. */
      pausedAt: record.pausedAt?.toISOString() ?? null,
      /** How many cases the batch holds, for the "C-1042 of 214" walk control. */
      batchSize,
    };
  }

  /**
   * The four manual overrides (contract: `OVERRIDE_ACTIONS` in `event-store.ts`).
   *
   * Four routes rather than one with a `kind` in the body, because they are
   * four different authorities and a URL that names the act is a URL an audit
   * log can be read against. Each answers with the ledger row it wrote, so the
   * browser continues the case's chain from the server's tip instead of
   * guessing at it.
   */
  @Post(":id/pause")
  @HttpCode(200)
  pause(
    @CurrentMerchant() merchant: SessionClaims,
    @Param("id") id: string,
    @Body() body: OverrideCaseDto,
  ) {
    return this.overrides.apply(
      merchant.sub,
      this.parse(id),
      "pause",
      merchant.name,
      body.note ?? null,
    );
  }

  @Post(":id/resume")
  @HttpCode(200)
  resume(
    @CurrentMerchant() merchant: SessionClaims,
    @Param("id") id: string,
    @Body() body: OverrideCaseDto,
  ) {
    return this.overrides.apply(
      merchant.sub,
      this.parse(id),
      "resume",
      merchant.name,
      body.note ?? null,
    );
  }

  @Post(":id/escalate")
  @HttpCode(200)
  escalate(
    @CurrentMerchant() merchant: SessionClaims,
    @Param("id") id: string,
    @Body() body: OverrideCaseDto,
  ) {
    return this.overrides.apply(
      merchant.sub,
      this.parse(id),
      "escalate",
      merchant.name,
      body.note ?? null,
    );
  }

  /**
   * GET /cases/:id/call-preview — what would stop a call, before one is asked for.
   *
   * The dialog behind "Ask Boa to call now" reads this and nothing else. It is
   * a dry run of the same `evaluateGate` the Executor will run, so the rules it
   * lists are the rules that will answer — rather than a second, hand-kept copy
   * of the policy that drifts the first time somebody edits the pack (B-79).
   */
  @Get(":id/call-preview")
  async callPreview(@CurrentMerchant() merchant: SessionClaims, @Param("id") id: string) {
    const caseId = this.parse(id);
    // 404s on a case that is not this merchant's, before the gate is asked.
    await this.cases.findOne(merchant.sub, caseId);

    const evaluation = await this.gate.preview(caseId, { channel: "VOICE" });

    const blocking = evaluation.checks.filter((check) => check.verdict === "block");

    return {
      allowed: evaluation.verdict === "allowed",
      /** Every bound currently objecting, and whether a human may spend it. */
      blocks: blocking.map((check) => ({
        name: check.name,
        note: check.note,
        waivable: WAIVABLE_CHECKS.includes(check.name),
      })),
      /**
       * True when something is objecting that no override lifts, so the dialog
       * offers no way through. Forcing past a cool-down is the merchant's call;
       * forcing past quiet hours or an opt-out is not on offer.
       */
      refused: blocking.some((check) => !WAIVABLE_CHECKS.includes(check.name)),
    };
  }

  @Post(":id/call")
  @HttpCode(200)
  async call(
    @CurrentMerchant() merchant: SessionClaims,
    @Param("id") id: string,
    @Body() body: OverrideCaseDto,
  ) {
    const caseId = this.parse(id);

    // The rules being stepped over are read here, before the case moves, so the
    // ledger row names them. A row that says "forced" without saying past what
    // is the same non-claim as a "Chain verified" badge that hashes nothing.
    const waived = body.force
      ? (await this.gate.preview(caseId, { channel: "VOICE" })).checks
          .filter((check) => check.verdict === "block")
          .map((check) => check.name)
      : [];

    return this.overrides.apply(
      merchant.sub,
      caseId,
      "call",
      merchant.name,
      body.note ?? null,
      body.force ?? false,
      waived,
    );
  }

  @Post(":id/resolve-external")
  @HttpCode(200)
  resolveExternal(
    @CurrentMerchant() merchant: SessionClaims,
    @Param("id") id: string,
    @Body() body: OverrideCaseDto,
  ) {
    return this.overrides.apply(
      merchant.sub,
      this.parse(id),
      "resolve-external",
      merchant.name,
      body.note ?? null,
    );
  }

  /** A reference that is not one is a 404, never a 500. */
  private parse(id: string): number {
    const caseId = parseCaseRef(id);
    if (caseId === null) {
      throw new NotFoundException({ error: `"${id}" is not a case reference.` });
    }
    return caseId;
  }
}
