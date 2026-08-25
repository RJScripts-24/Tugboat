import { policyPackSchema, type PolicyPack } from "./policy-pack";

const RUPEE = 100;

const V4: PolicyPack = {
  contact: { maxAttempts: 4, coolDownHours: 20, channelCaps: { WHATSAPP: 2, EMAIL: 2, VOICE: 1, RETRY: 2 } },
  quiet: { startMinutes: 21 * 60, endMinutes: 9 * 60, exemptSilentRetries: true },
  rules: { opt_out: true, sentiment: true, deadline: true, attempt_cap: true },
  sentimentThreshold: 0.7,
  escalation: {
    discountCapPercent: 15,
    valueThresholdPaise: 25_000 * RUPEE,
    b2bAlways: true,
    confidenceFloor: 0.6,
    hardship: true,
  },
  mandate: { maxPerCycle: 3, spacingDays: 3, alignToPayday: true },
  channels: { WHATSAPP: true, EMAIL: true, VOICE: true, RETRY: true },
};

const withPack = (mutate: (pack: PolicyPack) => void) => {
  const copy = structuredClone(V4);
  mutate(copy);
  return copy;
};

describe("the policy pack schema", () => {
  it("accepts the shipped pack unchanged", () => {
    const parsed = policyPackSchema.safeParse(V4);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual(V4);
  });

  it("refuses to represent opt-out as switched off", () => {
    const disabled = { ...V4, rules: { ...V4.rules, opt_out: false } };

    const parsed = policyPackSchema.safeParse(disabled);
    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues[0].path.join(".")).toBe("rules.opt_out");
  });

  it("will not even typecheck an off switch for opt-out", () => {
    // The literal `true` is what makes the rule unswitchable; the runtime
    // rejection above is the second line, not the first.
    // @ts-expect-error opt_out is typed as the literal true
    const invalid: PolicyPack = { ...V4, rules: { ...V4.rules, opt_out: false } };
    expect(invalid.rules.opt_out).toBe(false);
  });

  it("rejects an unknown field rather than storing it", () => {
    const parsed = policyPackSchema.safeParse({ ...V4, retryForever: true });
    expect(parsed.success).toBe(false);
  });

  it("rejects a pack missing a channel from a capped record", () => {
    const parsed = policyPackSchema.safeParse(
      withPack((pack) => {
        delete (pack.contact.channelCaps as Partial<PolicyPack["contact"]["channelCaps"]>).VOICE;
      }),
    );
    expect(parsed.success).toBe(false);
  });

  it.each<[string, PolicyPack]>([
    ["zero attempts", withPack((p) => (p.contact.maxAttempts = 0))],
    ["an unbounded attempt count", withPack((p) => (p.contact.maxAttempts = 99))],
    ["a fractional attempt count", withPack((p) => (p.contact.maxAttempts = 2.5))],
    ["a negative cool-down", withPack((p) => (p.contact.coolDownHours = -1))],
    ["a quiet-hour minute outside the day", withPack((p) => (p.quiet.startMinutes = 1500))],
    ["a confidence floor above 1", withPack((p) => (p.escalation.confidenceFloor = 1.4))],
    ["a discount cap above 100%", withPack((p) => (p.escalation.discountCapPercent = 250))],
    ["a negative value threshold", withPack((p) => (p.escalation.valueThresholdPaise = -1))],
    ["more re-presentations than RBI discipline allows", withPack((p) => (p.mandate.maxPerCycle = 12))],
    ["zero spacing between re-presentations", withPack((p) => (p.mandate.spacingDays = 0))],
    ["a sentiment threshold above 1", withPack((p) => (p.sentimentThreshold = 3))],
  ])("rejects %s", (_label, pack) => {
    expect(policyPackSchema.safeParse(pack).success).toBe(false);
  });

  it("allows quiet hours to be emptied, which is a legitimate merchant choice", () => {
    const noQuiet = withPack((pack) => {
      pack.quiet.startMinutes = 0;
      pack.quiet.endMinutes = 0;
    });
    expect(policyPackSchema.safeParse(noQuiet).success).toBe(true);
  });

  it("allows every channel to be switched off — that is how an agent is paused", () => {
    const paused = withPack((pack) => {
      pack.channels = { WHATSAPP: false, EMAIL: false, VOICE: false, RETRY: false };
    });
    expect(policyPackSchema.safeParse(paused).success).toBe(true);
  });
});
