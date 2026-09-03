import { Test } from "@nestjs/testing";

import { PrismaService } from "../prisma/prisma.service";
import { FakeLlmDriver } from "./fake-llm.driver";
import { LLM_DRIVER } from "./llm-driver.interface";
import { LlmService } from "./llm.service";
import { VoiceDialogueError, VoiceDialogueService, type DialogueContext } from "./voice-dialogue.service";
import { liveTurnSchema } from "./schemas";

describe("the voice dialogue engine", () => {
  let dialogue: VoiceDialogueService;
  let driver: FakeLlmDriver;
  let calls: { purpose: string }[];

  beforeEach(async () => {
    calls = [];
    driver = new FakeLlmDriver();

    const moduleRef = await Test.createTestingModule({
      providers: [
        LlmService,
        VoiceDialogueService,
        { provide: LLM_DRIVER, useValue: driver },
        {
          provide: PrismaService,
          useValue: {
            llmCall: {
              create: async ({ data }: { data: { purpose: string } }) => {
                calls.push(data);
                return data;
              },
            },
          },
        },
      ],
    }).compile();

    dialogue = moduleRef.get(VoiceDialogueService);
  });

  function context(overrides: Partial<DialogueContext> = {}): DialogueContext {
    return {
      caseId: 1001,
      customerName: "Ananya Sharma",
      merchantName: "Demo Merchant",
      amountLabel: "₹4,800",
      hinglish: false,
      promiseDateLabel: "Fri 28 Aug",
      counterpart: "promise",
      ...overrides,
    };
  }

  it("opens by naming Boa and the merchant, as the script rules require", async () => {
    const result = await dialogue.converse(context());
    const opener = result.transcript[0];

    expect(opener.speaker).toBe("BOA");
    expect(opener.text).toContain("Boa");
    expect(opener.text).toContain("Demo Merchant");
  });

  it("alternates speakers and ends on Boa", async () => {
    const { transcript } = await dialogue.converse(context());

    transcript.forEach((turn, index) => {
      expect(turn.speaker).toBe(index % 2 === 0 ? "BOA" : "CUSTOMER");
    });
    expect(transcript.at(-1)?.speaker).toBe("BOA");
  });

  it("reads a promise as PROMISED_TO_PAY and names the date it heard", async () => {
    const result = await dialogue.converse(context({ counterpart: "promise" }));

    expect(result.intent).toBe("PROMISED_TO_PAY");
    expect(result.transcript.map((turn) => turn.text).join(" ")).toContain("Fri 28 Aug");
    expect(result.summary).toContain("follow-up is scheduled");
  });

  it("reads a cash-flow constraint as hardship and stands down", async () => {
    const result = await dialogue.converse(context({ counterpart: "decline" }));

    expect(result.intent).toBe("HARDSHIP_DECLARED");
    // The rule the system prompt states: accept it immediately, never press.
    expect(result.transcript.at(-1)?.text.toLowerCase()).toMatch(/won.t push|pressure nahi/);
    expect(result.summary).toContain("stood down");
  });

  it("records an unanswered call honestly rather than as a refusal", async () => {
    const result = await dialogue.converse(context({ counterpart: "no-answer" }));

    expect(result.intent).toBe("NO_ANSWER");
    expect(result.transcript).toHaveLength(2);
    expect(result.summary).toContain("No voicemail was left");
  });

  it("speaks Hinglish when the customer prefers it", async () => {
    const result = await dialogue.converse(context({ hinglish: true }));

    expect(result.language).toBe("hi-IN");
    expect(result.transcript[0].text).toContain("Namaste");
    expect(result.transcript[0].text).toContain("bol rahi hoon");
  });

  it("never threatens, in either language", async () => {
    for (const hinglish of [false, true]) {
      for (const counterpart of ["promise", "decline", "no-answer"] as const) {
        const result = await dialogue.converse(context({ hinglish, counterpart }));
        const boa = result.transcript
          .filter((turn) => turn.speaker === "BOA")
          .map((turn) => turn.text)
          .join(" ")
          .toLowerCase();

        for (const word of ["legal", "court", "police", "penalty", "blacklist", "consequence"]) {
          expect(boa).not.toContain(word);
        }
      }
    }
  });

  it("sends no phone number or email to the model — masked identifiers only", async () => {
    const seen: string[] = [];
    driver.setOverride("dialogue", (request) => {
      seen.push(request.user);
      return JSON.stringify({ say: "Hello.", goal_complete: true });
    });

    await dialogue.converse(context());

    const prompts = seen.join(" ");
    expect(prompts).not.toMatch(/\+91|@|\d{10}/);
    // First name only, never the full one.
    expect(prompts).toContain("Ananya");
    expect(prompts).not.toContain("Ananya Sharma");
  });

  it("meters every turn it takes from the model", async () => {
    const result = await dialogue.converse(context({ counterpart: "promise" }));

    expect(result.turnsFromModel).toBe(4);
    expect(calls.filter((call) => call.purpose === "dialogue")).toHaveLength(4);
  });

  it("fails the call rather than inventing a line the model could not produce", async () => {
    driver.setOverride("dialogue", () => "I am not able to do that, sorry.");

    // No scripted fallback: a call the engine could not conduct is a failed
    // call, and the executor escalates it rather than recording a conversation
    // that never happened.
    await expect(dialogue.converse(context())).rejects.toThrow(VoiceDialogueError);
  });

  it("is reproducible — the same context twice gives the same transcript", async () => {
    const first = await dialogue.converse(context());
    const second = await dialogue.converse(context());

    expect(second.transcript).toEqual(first.transcript);
    expect(second.seconds).toBe(first.seconds);
  });
});

/**
 * B-83 — the promise-date pattern matched no date at all.
 *
 * `/^d{4}-d{2}-d{2}$/` is missing its escapes: it matches the literal string
 * "dddd-dd-dd" and rejects "2026-09-03". Every live call in which the customer
 * named a day therefore failed `liveTurnSchema`, threw out of `liveTurn`, and
 * ended with the controller reading the "line mein kuch dikkat" close to
 * somebody who had just agreed to pay. The two real calls that found it are on
 * cases C-5408 and C-5411.
 *
 * Tested through the schema rather than the service because the schema is where
 * the defect was, and a regex is exactly the kind of thing that looks right.
 */
describe("liveTurnSchema — the promise date (B-83)", () => {
  const turn = (promise_date: unknown) => ({
    say: "Theek hai, main aapko link bhej deti hoon.",
    end_call: true,
    intent: "PROMISED_TO_PAY" as const,
    promise_date,
  });

  it("accepts an ISO date, which is what the model returns", () => {
    const result = liveTurnSchema.safeParse(turn("2026-09-03"));
    expect(result.success).toBe(true);
  });

  it.each(["2026-01-01", "2026-12-31", "2027-06-15"])("accepts %s", (date) => {
    expect(liveTurnSchema.safeParse(turn(date)).success).toBe(true);
  });

  it("rejects the literal string the broken pattern used to accept", () => {
    expect(liveTurnSchema.safeParse(turn("dddd-dd-dd")).success).toBe(false);
  });

  it.each(["03-09-2026", "2026/09/03", "tonight", "aaj raat", ""])(
    "rejects %s",
    (value) => {
      expect(liveTurnSchema.safeParse(turn(value)).success).toBe(false);
    },
  );

  it("still allows no date at all, so a schema failure never hangs up on a customer", () => {
    expect(liveTurnSchema.safeParse(turn(null)).success).toBe(true);
    expect(
      liveTurnSchema.safeParse({
        say: "Dhanyavaad.",
        end_call: true,
        intent: "UNDECIDED" as const,
      }).success,
    ).toBe(true);
  });
});
