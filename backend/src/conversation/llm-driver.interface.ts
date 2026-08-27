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

/**
 * How long one model call may take before it is treated as a provider that
 * did not answer.
 *
 * Without a bound a hung connection holds the worker's slot for as long as the
 * socket lives, which on some networks is forever; the job is never retried
 * because it never fails. Thirty seconds is several times the slowest answer
 * either free tier gives, and short enough that a case stuck behind a dead
 * provider reaches a human in the same minute (D-130).
 */
export const LLM_TIMEOUT_MS = 30_000;
