import type { PolicyChannel } from "../policy/policy-pack";

/**
 * What one contact costs, in paise.
 *
 * One table rather than a constant inside each adapter, because the evidence
 * report prices the counterfactual arms with these same numbers. The naive arm
 * is only a fair comparison if its contacts are billed at what a TUGBOAT
 * contact is billed at: the arms differ in judgement, not in what they buy, and
 * two copies of a price would eventually disagree and quietly flatter one of
 * them.
 *
 * The figures are the paid rates for the providers this build targets, not the
 * free tiers it actually runs on. Reporting a real spend of zero would be true
 * and useless; the report carries both (ADR-11).
 */
export const CHANNEL_COST_PAISE: Record<PolicyChannel, number> = {
  /** Twilio WhatsApp business-initiated, Indian rate. */
  WHATSAPP: 42,
  /** Resend, per delivered message beyond the free 100/day. */
  EMAIL: 8,
  /** Per minute of Indian outbound telephony, billed to the whole minute. */
  VOICE: 55,
  /** A re-presentation costs nothing until it captures, and the MDR on a
   *  captured payment is not the agent's spend to report. */
  RETRY: 0,
};

/** Telephony bills whole minutes, which is why a 22-second no-answer is not free. */
export function voiceCostPaise(seconds: number): number {
  return Math.ceil(seconds / 60) * CHANNEL_COST_PAISE.VOICE;
}
