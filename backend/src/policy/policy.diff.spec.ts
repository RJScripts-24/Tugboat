import {
  diffPacks,
  nextFreeVersion,
  nextVersion,
  renderChange,
  summariseChanges,
  versionNumber,
} from "./policy.diff";
import type { PolicyPack } from "./policy-pack";

const RUPEE = 100;

const V4: PolicyPack = {
  contact: {
    maxAttempts: 4,
    coolDownHours: 20,
    channelCaps: { WHATSAPP: 2, EMAIL: 2, VOICE: 1, RETRY: 2 },
  },
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

const changed = (mutate: (pack: PolicyPack) => void) => {
  const copy = structuredClone(V4);
  mutate(copy);
  return diffPacks(V4, copy);
};

describe("the policy diff", () => {
  it("reports nothing when nothing moved", () => {
    expect(diffPacks(V4, structuredClone(V4))).toEqual([]);
  });

  it("names the field, both values, and which way the bound went", () => {
    expect(changed((pack) => (pack.contact.maxAttempts = 6))).toEqual([
      {
        path: "contact.maxAttempts",
        label: "Attempts per case",
        from: "4",
        to: "6",
        direction: "looser",
      },
    ]);
  });

  it("knows that a longer cool-down is tighter, not looser", () => {
    expect(changed((pack) => (pack.contact.coolDownHours = 30))[0]).toMatchObject({
      direction: "tighter",
    });
    expect(changed((pack) => (pack.contact.coolDownHours = 6))[0]).toMatchObject({
      direction: "looser",
    });
  });

  it("reads a switched-off stopping rule as a loosening", () => {
    expect(changed((pack) => (pack.rules.sentiment = false))[0]).toMatchObject({
      path: "rules.sentiment",
      from: "on",
      to: "off",
      direction: "looser",
    });
  });

  it("renders money and clocks the way the page does", () => {
    expect(
      changed((pack) => (pack.escalation.valueThresholdPaise = 50_000 * RUPEE))[0],
    ).toMatchObject({
      from: "₹25,000",
      to: "₹50,000",
    });
    expect(changed((pack) => (pack.quiet.startMinutes = 22 * 60))[0]).toMatchObject({
      from: "21:00",
      to: "22:00",
      // A later start means a shorter quiet window: more hours contactable.
      direction: "looser",
    });
  });

  it("refuses to grade payday alignment as either — it is scheduling, not a bound", () => {
    expect(changed((pack) => (pack.mandate.alignToPayday = false))[0]).toMatchObject({
      direction: "changed",
    });
  });

  it("walks every channel cap and switch", () => {
    const diff = changed((pack) => {
      pack.contact.channelCaps.VOICE = 2;
      pack.channels.EMAIL = false;
    });

    expect(diff.map((change) => change.path)).toEqual([
      "contact.channelCaps.VOICE",
      "channels.EMAIL",
    ]);
  });

  it("collects several changes in one pass", () => {
    const diff = changed((pack) => {
      pack.contact.maxAttempts = 6;
      pack.contact.coolDownHours = 6;
    });

    expect(diff).toHaveLength(2);
    expect(diff.map(renderChange)).toEqual([
      "contact.maxAttempts 4 → 6",
      "contact.coolDownHours 20h → 6h",
    ]);
  });

  it("summarises a save in the words the revision list uses", () => {
    expect(summariseChanges(changed((pack) => (pack.contact.maxAttempts = 6)))).toBe(
      "Loosened — Attempts per case",
    );
    expect(summariseChanges(changed((pack) => (pack.contact.channelCaps.VOICE = 0)))).toBe(
      "Tightened — Voice cap",
    );
    expect(
      summariseChanges(
        changed((pack) => {
          pack.contact.maxAttempts = 6;
          pack.contact.channelCaps.VOICE = 0;
        }),
      ),
    ).toContain("+1 more");
    expect(summariseChanges([])).toBe("No change");
  });

  it("bumps the version label", () => {
    expect(nextVersion("v4")).toBe("v5");
    expect(nextVersion("v19")).toBe("v20");
    expect(nextVersion("draft")).toBe("v2");
  });
});

/**
 * The allocator, after B-24.
 *
 * A label has to be free across the whole table, not merely one past whatever
 * happens to be in force — a version stays in the history after it stops being
 * active, so the two numbers can differ and the difference is exactly where the
 * collision lived.
 */
describe("nextFreeVersion", () => {
  it("follows the highest label ever cut, not the active one", () => {
    // v4 in force with v5, v6 and v7 already in the history is precisely what a
    // reseed leaves behind, and it used to produce "v5" three times in a row.
    expect(nextFreeVersion(["v1", "v2", "v3", "v4", "v5", "v6", "v7"])).toBe("v8");
  });

  it("does not care what order the labels arrive in", () => {
    expect(nextFreeVersion(["v7", "v2", "v5"])).toBe("v8");
  });

  it("starts at v1 for a merchant with no history", () => {
    expect(nextFreeVersion([])).toBe("v1");
  });

  it("ignores labels it cannot read rather than throwing on them", () => {
    expect(nextFreeVersion(["draft", "v3", "rollback"])).toBe("v4");
  });

  it("advances past a gap rather than filling it", () => {
    // Reusing a freed number would give two different packs the same name, and
    // every policy decision that pointed at the old one would start reading as
    // though it had been judged by the new.
    expect(nextFreeVersion(["v1", "v9"])).toBe("v10");
  });

  it("keeps advancing when called repeatedly, which is what makes the retry work", () => {
    const taken = ["v1", "v2"];
    const first = nextFreeVersion(taken);
    taken.push(first);

    expect(first).toBe("v3");
    expect(nextFreeVersion(taken)).toBe("v4");
  });
});

describe("versionNumber", () => {
  it("reads our labels and refuses anything else", () => {
    expect(versionNumber("v12")).toBe(12);
    expect(versionNumber("12")).toBe(12);
    expect(versionNumber("draft")).toBeNull();
  });
});
