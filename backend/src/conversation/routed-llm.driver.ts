import { Logger } from "@nestjs/common";

import type { LlmDriver, LlmPurpose, LlmRequest, LlmResponse } from "./llm-driver.interface";

/**
 * Sends each purpose to the model that suits it (PRD 5.3).
 *
 * Reasoning work goes to the stronger model; high-volume, low-stakes work goes
 * to the fast one. Routing lives here rather than at call sites so a caller
 * never names a provider — which is what keeps the swap to a production model a
 * config change instead of an edit to business logic.
 */
const REASONING: LlmPurpose[] = ["diagnosis", "dialogue"];

export class RoutedLlmDriver implements LlmDriver {
  private readonly logger = new Logger(RoutedLlmDriver.name);

  constructor(
    private readonly reasoning: LlmDriver,
    private readonly fast: LlmDriver,
  ) {}

  get provider(): string {
    return this.reasoning.provider === this.fast.provider
      ? this.reasoning.provider
      : `${this.reasoning.provider}+${this.fast.provider}`;
  }

  private driverFor(purpose: LlmPurpose): LlmDriver {
    return REASONING.includes(purpose) ? this.reasoning : this.fast;
  }

  modelFor(purpose: LlmPurpose): string {
    return this.driverFor(purpose).modelFor(purpose);
  }

  complete(request: LlmRequest): Promise<LlmResponse> {
    const driver = this.driverFor(request.purpose);
    this.logger.debug(`${request.purpose} -> ${driver.provider}/${driver.modelFor(request.purpose)}`);
    return driver.complete(request);
  }
}
