import { DIFFICULTY, DIFFICULTY_KEYS, type DifficultyKey } from "./difficulty";
import { buildPersona, type Disposition, type Persona } from "./persona";
import { reactTo, retryCaptures, selfRecoversBy, voiceCounterpart } from "./persona-engine";

/**
 * The population is what it says on the tin.
 *
 * Each difficulty preset states a response rate, an opt-out rate and a silent
 * tail on the page a merchant reads, and those three numbers are the single
 * biggest lever on every figure in the evidence report. If the generator drifted
 * from them — if "38% answer" quietly became 30% — the headline would move and
 * nothing would say so. These tests are the only thing standing between the
 * caption and the batch.
 */

const HOUR = 60 * 60_000;

function drawPopulation(difficulty: DifficultyKey, size = 3_000): Persona[] {
  return Array.from({ length: size }, (_, index) =>
    buildPersona({
      index,
      runSeed: `spec/${difficulty}`,
      difficulty,
      caseType: "PAYMENT_FAILED",
      trueRootCause: "INSUFFICIENT_FUNDS",
      amountPaise: 480_000,
    }),
  );
}

const shareOf = (people: Persona[], predicate: (persona: Persona) => boolean) =>
  people.filter(predicate).length / people.length;

const ANSWERING: Disposition[] = [
  "pays-on-nudge",
  "promises",
  "haggles",
  "hardship",
  "hostile",
];

describe("the drawn population matches the preset it was drawn from", () => {
  for (const difficulty of DIFFICULTY_KEYS) {
    describe(difficulty, () => {
      const preset = DIFFICULTY[difficulty];
      const people = drawPopulation(difficulty);

      it("answers at about the advertised rate", () => {
        const answering = shareOf(people, (persona) =>
          ANSWERING.includes(persona.disposition),
        );
        expect(answering).toBeCloseTo(preset.responseRate, 1);
      });

      it("opts out at about the advertised rate", () => {
        const optOuts = shareOf(people, (persona) => persona.disposition === "opts-out");
        expect(Math.abs(optOuts - preset.optOutRate)).toBeLessThan(0.02);
      });

      it("carries the advertised silent tail", () => {
        const silent = shareOf(people, (persona) => persona.disposition === "silent");
        expect(Math.abs(silent - preset.silentTail)).toBeLessThan(0.03);
      });

      it("would self-recover at about the advertised baseline rate", () => {
        const self = shareOf(people, (persona) => persona.wouldSelfRecover);
        expect(Math.abs(self - preset.selfRecoveryRate)).toBeLessThan(0.025);
      });
    });
  }

  it("gets harsher, preset by preset, in the direction the captions claim", () => {
    const easy = drawPopulation("easy");
    const realistic = drawPopulation("realistic");
    const hostile = drawPopulation("hostile");

    const answering = (people: Persona[]) =>
      shareOf(people, (persona) => ANSWERING.includes(persona.disposition));

    expect(answering(easy)).toBeGreaterThan(answering(realistic));
    expect(answering(realistic)).toBeGreaterThan(answering(hostile));
    expect(shareOf(hostile, (p) => p.disposition === "silent")).toBeGreaterThan(
      shareOf(realistic, (p) => p.disposition === "silent"),
    );
  });
});

describe("a persona is internally consistent", () => {
  const people = drawPopulation("realistic", 1_500);

  it("gives the same person for the same seed and index", () => {
    const draw = () =>
      buildPersona({
        index: 17,
        runSeed: "spec/stability",
        difficulty: "realistic",
        caseType: "MANDATE_FAILED",
        trueRootCause: "MANDATE_REVOKED",
        amountPaise: 120_000,
      });

    expect(draw()).toEqual(draw());
  });

  it("never lets somebody who is about to send STOP quietly pay first", () => {
    for (const persona of people.filter((p) => p.disposition === "opts-out")) {
      expect(persona.silentConversion).toBe(0);
      expect(persona.wouldSelfRecover).toBe(false);
    }
  });

  it("lets somebody who never replies still pay the link", () => {
    // Refusing to reply is not refusing to pay, and conflating the two caps the
    // recovery rate at the response rate (B-32).
    const ignorers = people.filter((p) => p.disposition === "ignores");
    expect(ignorers.length).toBeGreaterThan(50);

    for (const persona of ignorers) {
      expect(persona.responsiveness.WHATSAPP).toBe(0);
      expect(persona.silentConversion).toBeGreaterThan(0);
    }

    const paid = ignorers.filter((persona) =>
      reactTo(persona, contactAt(0)).some((reaction) => reaction.kind === "pay"),
    );

    expect(paid.length).toBeGreaterThan(0);
    // ...and never a reply, because they still do not answer.
    for (const persona of ignorers) {
      expect(reactTo(persona, contactAt(0)).some((r) => r.kind === "reply")).toBe(false);
    }
  });

  it("never lets the silent tail pay by any route", () => {
    for (const persona of people.filter((p) => p.disposition === "silent")) {
      expect(persona.silentConversion).toBe(0);
      expect(persona.wouldSelfRecover).toBe(false);
      expect(persona.fundsAvailableAfterHours).toBe(Infinity);
    }
  });

  it("puts no funds behind an expired card or a revoked mandate, whatever the persona", () => {
    for (const cause of ["CARD_EXPIRED", "MANDATE_REVOKED"] as const) {
      const persona = buildPersona({
        index: 3,
        runSeed: "spec/instrument",
        difficulty: "easy",
        caseType: "PAYMENT_FAILED",
        trueRootCause: cause,
        amountPaise: 300_000,
      });

      // These need the customer to act. No amount of re-presenting fixes them,
      // which is why their playbooks open with a message rather than a retry.
      expect(persona.fundsAvailableAfterHours).toBe(Infinity);
      expect(retryCaptures(persona, contactAt(0))).toBe(false);
    }
  });

  it("puts businesses on email and consumers on WhatsApp", () => {
    const business = people.filter((persona) => persona.segment === "B2B");
    const consumer = people.filter((persona) => persona.segment === "B2C");

    const ratio = (group: Persona[]) =>
      group.reduce((sum, p) => sum + p.responsiveness.EMAIL - p.responsiveness.WHATSAPP, 0) /
      group.length;

    expect(ratio(business)).toBeGreaterThan(ratio(consumer));
  });
});

describe("what a persona does about a contact", () => {
  // Drawn from `realistic` rather than `easy`, because `easy` has no silent
  // tail at all and a lookup for one would find nothing.
  const persona = (disposition: Disposition, index: number): Persona => {
    const people = drawPopulation("realistic", 4_000).filter(
      (p) => p.disposition === disposition,
    );
    expect(people.length).toBeGreaterThan(0);
    return people[index % people.length];
  };

  it("answers an opt-out with a keyword the deterministic matcher will catch", () => {
    const reactions = reactTo(persona("opts-out", 0), contactAt(0));
    const reply = reactions.find((r) => r.kind === "reply");

    expect(reply).toBeDefined();
    expect(reply && "text" in reply ? reply.text.toUpperCase() : "").toMatch(
      /STOP|UNSUBSCRIBE|BAND KARO|बंद करो|मत भेजो/,
    );
  });

  it("says nothing at all to a silent retry — there is nobody to answer it", () => {
    expect(reactTo(persona("pays-on-nudge", 0), { ...contactAt(0), channel: "RETRY" })).toEqual([]);
  });

  it("makes a haggler ask for a price before they will pay, and pay once given one", () => {
    // Reach is rolled per contact, so not every haggler answers this one. What
    // must hold is that the ones who do answer are objecting to the amount —
    // that reply is the only signal in the whole system that lets a concession
    // be proposed at all (D-71).
    const hagglers = drawPopulation("realistic", 4_000).filter(
      (p) => p.disposition === "haggles",
    );

    const answered = hagglers
      .map((haggler) => ({ haggler, reply: reactTo(haggler, contactAt(0)).find((r) => r.kind === "reply") }))
      .filter((row) => row.reply !== undefined);

    expect(answered.length).toBeGreaterThan(10);

    for (const { reply } of answered.slice(0, 25)) {
      expect(reply && "text" in reply ? reply.text.toLowerCase() : "").toMatch(
        /discount|price|costly|expensive|offer|kam kar|mehenga/,
      );
    }

    const given = reactTo(answered[0].haggler, { ...contactAt(0), concessionPaise: 48_000 });
    expect(given.some((r) => r.kind === "pay")).toBe(true);
  });

  it("never pays before the money exists", () => {
    const slow = buildPersona({
      index: 9,
      runSeed: "spec/funds",
      difficulty: "easy",
      caseType: "PAYMENT_FAILED",
      trueRootCause: "INSUFFICIENT_FUNDS",
      amountPaise: 480_000,
    });

    for (const reaction of reactTo(slow, contactAt(0))) {
      if (reaction.kind !== "pay") continue;
      if (!Number.isFinite(slow.fundsAvailableAfterHours)) continue;
      expect(reaction.atMs).toBeGreaterThanOrEqual(slow.fundsAvailableAfterHours * HOUR);
    }
  });

  it("does not pick up the phone for somebody who never answers anything", () => {
    expect(voiceCounterpart(persona("silent", 0), contactAt(0))).toBe("no-answer");
  });

  it("stops paying, and starts leaving, once contacted past its tolerance", () => {
    // The reason bounds exist. A model in which more messages are always better
    // implies no merchant should ever have a cap, which is a conclusion a policy
    // simulator must not be able to produce.
    const people = drawPopulation("realistic", 2_000).filter(
      (p) => p.disposition === "pays-on-nudge" || p.disposition === "ignores",
    );

    const over = people.map((persona) =>
      reactTo(persona, {
        ...contactAt(40),
        attempt: persona.complaintThreshold + 2,
        contactsSoFar: persona.complaintThreshold + 2,
      }),
    );

    const optOuts = over.filter((reactions) =>
      reactions.some((r) => r.kind === "reply" && /STOP|UNSUBSCRIBE|बंद|मत भेजो|BAND/i.test(r.text)),
    );
    const paid = over.filter((reactions) => reactions.some((r) => r.kind === "pay"));

    const within = people.map((persona) => reactTo(persona, contactAt(0)));
    const paidWithin = within.filter((reactions) => reactions.some((r) => r.kind === "pay"));

    expect(optOuts.length).toBeGreaterThan(0);
    expect(paid.length).toBeLessThan(paidWithin.length);
  });

  it("self-recovers only after its own window, never before", () => {
    const payer = drawPopulation("easy", 2_000).find((p) => p.wouldSelfRecover)!;

    expect(selfRecoversBy(payer, payer.selfRecoverAfterHours - 1)).toBe(false);
    expect(selfRecoversBy(payer, payer.selfRecoverAfterHours + 1)).toBe(true);
  });
});

function contactAt(hours: number) {
  return {
    channel: "WHATSAPP" as const,
    attempt: 1,
    atMs: hours * HOUR,
    openedAtMs: 0,
    contactsSoFar: 1,
  };
}
