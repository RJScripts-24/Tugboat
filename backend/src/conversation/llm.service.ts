import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ZodType } from "zod";

import { PrismaService } from "../prisma/prisma.service";
import {
  LLM_DRIVER,
  type LlmDriver,
  type LlmPurpose,
  type LlmRequest,
} from "./llm-driver.interface";
import { extractJson } from "./schemas";

/**
 * Production token prices in paise per 1,000 tokens.
 *
 * Actual spend on the free tiers is zero. Metering both figures is what lets
 * the evidence report say "this batch cost ₹0 to run and would cost ₹X in
 * production" — a far better answer than either number alone (ADR-11).
 */
const PROJECTED_PRICE_PAISE = {
  in: 1.2,
  out: 4.8,
};

export class LlmSchemaError extends Error {
  constructor(
    readonly purpose: LlmPurpose,
    readonly issues: string,
    readonly raw: string,
  ) {
    super(`Model output failed the ${purpose} schema: ${issues}`);
  }
}

export type LlmContext = {
  caseId?: number;
  simRunId?: string;
};

export type StructuredResult<T> = {
  value: T;
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  attempts: number;
};

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);

  constructor(
    @Inject(LLM_DRIVER) private readonly driver: LlmDriver,
    private readonly prisma: PrismaService,
  ) {}

  get provider(): string {
    return this.driver.provider;
  }

  /**
   * Asks for structured output and refuses to return anything that does not
   * match the schema.
   *
   * One repair attempt is allowed, because a model that produced prose around
   * its JSON usually fixes itself when told so. A second failure throws: the
   * caller escalates to a human rather than acting on a guess, which is the
   * whole point of treating model output as untrusted input.
   */
  async structured<T>(
    request: LlmRequest,
    schema: ZodType<T>,
    context: LlmContext = {},
  ): Promise<StructuredResult<T>> {
    let lastIssues = "";
    let lastRaw = "";

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const response = await this.driver.complete({
        temperature: 0,
        ...request,
        repair: attempt === 1 ? undefined : `Your previous reply was rejected: ${lastIssues}`,
      });

      await this.meter(request.purpose, response, context);

      const parsed = schema.safeParse(safeJson(response.text));

      if (parsed.success) {
        return {
          value: parsed.data,
          provider: response.provider,
          model: response.model,
          tokensIn: response.tokensIn,
          tokensOut: response.tokensOut,
          latencyMs: response.latencyMs,
          attempts: attempt,
        };
      }

      lastIssues = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      lastRaw = response.text;

      this.logger.warn(
        `${request.purpose} output rejected on attempt ${attempt}: ${lastIssues}`,
      );
    }

    throw new LlmSchemaError(request.purpose, lastIssues, lastRaw);
  }

  /** Every call is recorded against its case, whether or not it was useful. */
  private async meter(
    purpose: LlmPurpose,
    response: { provider: string; model: string; tokensIn: number; tokensOut: number; latencyMs: number },
    context: LlmContext,
  ): Promise<void> {
    const projected = Math.round(
      (response.tokensIn / 1000) * PROJECTED_PRICE_PAISE.in +
        (response.tokensOut / 1000) * PROJECTED_PRICE_PAISE.out,
    );

    await this.prisma.llmCall.create({
      data: {
        caseId: context.caseId,
        simRunId: context.simRunId,
        provider: response.provider,
        model: response.model,
        purpose,
        tokensIn: response.tokensIn,
        tokensOut: response.tokensOut,
        // Free tiers cost nothing; the projection is what carries the story.
        costPaise: 0,
        projectedCostPaise: projected,
        latencyMs: response.latencyMs,
      },
    });
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(extractJson(text));
  } catch {
    // Returning the raw string lets the schema produce a useful complaint
    // ("expected object, received string") instead of a parser stack trace.
    return text;
  }
}
