import {
  buildSeed,
  canonicalJson,
  maskedPathsIn,
  payloadDigest,
  type SeedFields,
} from "./ledger-seed";

function fields(overrides: Partial<SeedFields> = {}): SeedFields {
  return {
    chain: "C-1188",
    seq: 3,
    atMs: 1_756_123_456_789,
    actor: "BOA",
    action: "ACTION_EXECUTED",
    caseId: "C-1188",
    detail: "WhatsApp nudge sent · attempt 2 of 4",
    payload: { case_id: "C-1188", channel: "WHATSAPP", body_lines: 4 },
    ...overrides,
  };
}

describe("canonicalJson", () => {
  it("sorts keys, so two builders of the same payload agree", () => {
    // JSON.stringify keeps insertion order, so a payload assembled by two code
    // paths in a different order would digest differently — a chain that breaks
    // depending on which branch wrote the row.
    const a = canonicalJson({ b: 1, a: 2, c: 3 });
    const b = canonicalJson({ c: 3, a: 2, b: 1 });

    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":3}');
  });

  it("sorts nested keys too", () => {
    expect(canonicalJson({ outer: { z: 1, a: 2 } })).toBe('{"outer":{"a":2,"z":1}}');
  });

  it("keeps array order, because an array's order is data", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
  });

  it("handles the scalars a payload actually contains", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(0)).toBe("0");
    expect(canonicalJson("")).toBe('""');
  });

  it("escapes strings the way JSON does, so a quote cannot end a value early", () => {
    expect(canonicalJson({ detail: 'he said "stop"' })).toBe('{"detail":"he said \\"stop\\""}');
  });

  it("distinguishes a number from the string of that number", () => {
    expect(canonicalJson({ n: 1 })).not.toBe(canonicalJson({ n: "1" }));
  });
});

describe("payloadDigest", () => {
  it("is stable across key order", () => {
    expect(payloadDigest({ a: 1, b: 2 })).toBe(payloadDigest({ b: 2, a: 1 }));
  });

  it("moves when any value moves", () => {
    expect(payloadDigest({ amount_paise: 480_000 })).not.toBe(
      payloadDigest({ amount_paise: 480_001 }),
    );
  });

  it("moves when a field is removed", () => {
    expect(payloadDigest({ a: 1, b: 2 })).not.toBe(payloadDigest({ a: 1 }));
  });

  it("is sixteen hex characters — long enough that a collision is not stumbled into", () => {
    expect(payloadDigest({ any: "payload" })).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("buildSeed", () => {
  it("covers every field the row asserts", () => {
    const base = buildSeed(fields());

    const moved: Partial<SeedFields>[] = [
      { chain: "C-9999" },
      { seq: 4 },
      { atMs: 1_756_123_456_790 },
      { actor: "HUMAN" },
      { action: "APPROVAL_DECIDED" },
      { caseId: null },
      { detail: "WhatsApp nudge sent · attempt 3 of 4" },
      { payload: { case_id: "C-1188", channel: "EMAIL", body_lines: 4 } },
    ];

    for (const change of moved) {
      expect(buildSeed(fields(change))).not.toBe(base);
    }
  });

  it("is reproducible from the same fields", () => {
    expect(buildSeed(fields())).toBe(buildSeed(fields()));
  });

  it("escapes pipes, so a detail line cannot forge a field boundary", () => {
    // Without escaping, a detail of "a|b" and a detail of "a" followed by a
    // field starting "b" could produce the same preimage — a collision an
    // attacker chooses rather than one they have to find.
    const withPipe = buildSeed(fields({ detail: "a|b" }));
    const withoutPipe = buildSeed(fields({ detail: "a" }));

    expect(withPipe).toContain("a\\|b");
    expect(withPipe).not.toBe(withoutPipe);
  });

  it("escapes backslashes, so the escape itself cannot be forged", () => {
    const a = buildSeed(fields({ detail: "a\\|b" }));
    const b = buildSeed(fields({ detail: "a|b" }));

    expect(a).not.toBe(b);
  });

  it("writes a dash where there is no case, never an empty field", () => {
    expect(buildSeed(fields({ chain: "policy", caseId: null }))).toContain("|-|");
  });

  it("stays short enough to render beside the row it describes", () => {
    const large = {
      rows: Array.from({ length: 200 }, (_, i) => ({ label: `row ${i}`, value: i })),
    };
    // The payload travels as a digest precisely so this stays true: a preimage
    // nobody can read is a verification nobody performs.
    expect(buildSeed(fields({ payload: large })).length).toBeLessThan(200);
  });
});

describe("maskedPathsIn", () => {
  it("finds a masked value by the marker in the stored string", () => {
    expect(maskedPathsIn({ recipient: "98•••••210" })).toEqual(["recipient"]);
  });

  it("reports nothing when nothing was masked", () => {
    expect(maskedPathsIn({ amount_paise: 480_000, channel: "EMAIL" })).toEqual([]);
  });

  it("walks nested objects and arrays with dotted paths", () => {
    const payload = {
      customer: { name: "Ananya Sharma", contact: "98•••••210" },
      copies: [{ to: "a•••••@example.test" }, { to: "plain@example.test" }],
    };

    expect(maskedPathsIn(payload)).toEqual(["customer.contact", "copies[0].to"]);
  });

  it("does not claim the payload root itself was masked", () => {
    expect(maskedPathsIn("98•••••210")).toEqual([]);
  });
});
