import { z } from "zod";

/**
 * Strict schemas for every structured thing a model is asked to produce.
 *
 * The LLM's output is untrusted input (ADR-3). Nothing a model returns reaches
 * a case, a customer or a decision until it has survived one of these — and
 * `.strict()` matters: an extra key means the model improvised, and improvising
 * is exactly what must not silently pass.
 */

export const ROOT_CAUSES = [
  "BANK_GATEWAY_DEGRADED",
  "INSUFFICIENT_FUNDS",
  "CUSTOMER_DISTRACTED",
  "CARD_EXPIRED",
  "MANDATE_REVOKED",
  "UNKNOWN",
] as const;

export const diagnosisSchema = z
  .object({
    root_cause: z.enum(ROOT_CAUSES),
    confidence: z.number().min(0).max(1),
    reasoning: z.string().min(1).max(600),
    evidence: z.array(z.string().min(1)).max(8).default([]),
  })
  .strict();

export type DiagnosisOutput = z.infer<typeof diagnosisSchema>;

export const sentimentSchema = z
  .object({
    sentiment: z.enum(["positive", "neutral", "negative", "opt-out"]),
    score: z.number().min(-1).max(1),
    reasoning: z.string().min(1).max(400),
  })
  .strict();

export type SentimentOutput = z.infer<typeof sentimentSchema>;

/**
 * Models are fond of wrapping JSON in prose or a fenced code block. Stripping
 * that is fair game; anything beyond it is the model failing the contract, and
 * the schema is left to reject it.
 */
export function extractJson(text: string): string {
  const trimmed = text.trim();

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced) return fenced[1].trim();

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) return trimmed.slice(start, end + 1);

  return trimmed;
}

/**
 * One turn of the voice dialogue.
 *
 * Deliberately narrow: the model produces a line to say and nothing else. It
 * does not decide the outcome of the call, whether a promise was made, or what
 * happens next — those are read from the conversation by code, because an agent
 * that both conducts the call and grades it can report whatever it likes.
 */
export const dialogueTurnSchema = z
  .object({
    say: z.string().min(1).max(400),
    /** Whether the model believes the current goal is met. Advisory only. */
    goal_complete: z.boolean(),
  })
  .strict();

export type DialogueTurnOutput = z.infer<typeof dialogueTurnSchema>;

/**
 * One of Boa's lines on a real call, where the customer's words arrive from
 * speech recognition. The model may say when the call should end and what it
 * believes was agreed; the executor still reads the outcome off the transcript
 * the webhooks recorded (D-144).
 */
export const liveTurnSchema = z
  .object({
    say: z.string().min(1).max(400),
    end_call: z.boolean(),
    intent: z.enum(["PROMISED_TO_PAY", "HARDSHIP_DECLARED", "UNDECIDED"]),
    /**
     * The day the customer actually named, as YYYY-MM-DD, or null when they
     * named none.
     *
     * Optional rather than required on purpose. A missing field here falls back
     * to the old horizon; a schema failure on a live call ends with Boa hanging
     * up on a real customer (B-72), and no date is not worth that.
     */
    promise_date: z
      .string()
      // `\d`, not `d`. Without the escapes this matched the literal string
      // "dddd-dd-dd" and rejected every real date, so a customer who named one
      // failed the schema, the turn threw, and Boa read the polite line about a
      // bad connection to somebody who had just agreed to pay (B-83).
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
  })
  .strict();

export type LiveTurnOutput = z.infer<typeof liveTurnSchema>;
