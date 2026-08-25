import { z } from "zod";

/**
 * The policy pack, and the schema that guards writes to it.
 *
 * Mirrors `frontend/src/lib/policies-data.ts` field for field: the Policies
 * page edits this object, the PolicyGate reads it, and the evidence report
 * counts how often each field stopped something.
 */

export const POLICY_CHANNELS = ["WHATSAPP", "EMAIL", "VOICE", "RETRY"] as const;
export type PolicyChannel = (typeof POLICY_CHANNELS)[number];

/** A retry re-presents the payment to the gateway and reaches no person, so the rules that exist to protect people do not hold it. */
export const SILENT_CHANNELS: ReadonlySet<PolicyChannel> = new Set<PolicyChannel>(["RETRY"]);

export const CHANNEL_LABELS: Record<PolicyChannel, string> = {
  WHATSAPP: "WhatsApp",
  EMAIL: "Email",
  VOICE: "Voice",
  RETRY: "Retry",
};

const channelRecord = <T extends z.ZodTypeAny>(value: T) =>
  z.object({ WHATSAPP: value, EMAIL: value, VOICE: value, RETRY: value }).strict();

const perCaseCap = z.number().int().min(0).max(10);
const minuteOfDay = z.number().int().min(0).max(1439);
const probability = z.number().min(0).max(1);

export const policyPackSchema = z
  .object({
    contact: z
      .object({
        maxAttempts: z.number().int().min(1).max(10),
        coolDownHours: z.number().min(0).max(168),
        channelCaps: channelRecord(perCaseCap),
      })
      .strict(),
    quiet: z
      .object({
        startMinutes: minuteOfDay,
        endMinutes: minuteOfDay,
        exemptSilentRetries: z.boolean(),
      })
      .strict(),
    rules: z
      .object({
        // Not a boolean: the one rule a merchant may not switch off is the one
        // this schema refuses to represent as off (PRD 9.4).
        opt_out: z.literal(true),
        sentiment: z.boolean(),
        deadline: z.boolean(),
        attempt_cap: z.boolean(),
      })
      .strict(),
    sentimentThreshold: probability,
    escalation: z
      .object({
        discountCapPercent: z.number().min(0).max(100),
        valueThresholdPaise: z.number().int().min(0),
        b2bAlways: z.boolean(),
        confidenceFloor: probability,
        hardship: z.boolean(),
      })
      .strict(),
    mandate: z
      .object({
        // RBI e-mandate discipline is a handful of re-presentations per cycle,
        // never a stream; the upper bound is part of the guardrail.
        maxPerCycle: z.number().int().min(1).max(5),
        spacingDays: z.number().int().min(1).max(30),
        alignToPayday: z.boolean(),
      })
      .strict(),
    channels: channelRecord(z.boolean()),
  })
  .strict();

export type PolicyPack = z.infer<typeof policyPackSchema>;

/** The dotted path Zod reports when a write tries to switch opt-out off. */
export const OPT_OUT_PATH = "rules.opt_out";

export function packChannelLabel(channel: PolicyChannel): string {
  return CHANNEL_LABELS[channel];
}
