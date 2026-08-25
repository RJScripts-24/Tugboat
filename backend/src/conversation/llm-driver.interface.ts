/**
 * The provider-agnostic seam (PRD 5.3).
 *
 * One interface, several drivers, per-purpose routing. The agent is model-
 * agnostic by construction: on free tiers today, and swapping in a production
 * model later is a config change rather than an edit to any business logic.
 */

export type LlmPurpose =
  | "diagnosis"
  | "drafting"
  | "sentiment"
  | "dialogue"
  | "persona"
  | "summary";

export type LlmRequest = {
  purpose: LlmPurpose;
  system: string;
  user: string;
  /** Zero everywhere by default: a reproducible batch is worth more than variety. */
  temperature?: number;
  maxTokens?: number;
  /** Set on a retry so a driver can nudge itself back to valid output. */
  repair?: string;
};

export type LlmResponse = {
  text: string;
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
};

export interface LlmDriver {
  readonly provider: string;
  modelFor(purpose: LlmPurpose): string;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

export const LLM_DRIVER = Symbol("LLM_DRIVER");
