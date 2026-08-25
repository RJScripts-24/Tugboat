import { Test } from "@nestjs/testing";

import { PrismaService } from "../prisma/prisma.service";
import { FakeLlmDriver } from "./fake-llm.driver";
import { LLM_DRIVER } from "./llm-driver.interface";
import { LlmSchemaError, LlmService } from "./llm.service";
import { diagnosisSchema, extractJson } from "./schemas";

describe("extractJson", () => {
  it("returns plain JSON untouched", () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });

  it("unwraps a fenced code block, which models love to add", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJson('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("digs the object out of surrounding prose", () => {
    expect(extractJson('Sure! Here you go:\n{"a":1}\nHope that helps.')).toBe('{"a":1}');
  });

  it("leaves something with no object alone, so the schema can reject it", () => {
    expect(extractJson("I cannot help with that")).toBe("I cannot help with that");
  });
});

describe("LlmService", () => {
  let service: LlmService;
  let driver: FakeLlmDriver;
  let calls: { purpose: string; tokensIn: number; tokensOut: number; projectedCostPaise: number }[];

  beforeEach(async () => {
    calls = [];
    driver = new FakeLlmDriver();

    const moduleRef = await Test.createTestingModule({
      providers: [
        LlmService,
        { provide: LLM_DRIVER, useValue: driver },
        {
          provide: PrismaService,
          useValue: {
            llmCall: {
              create: async ({ data }: { data: (typeof calls)[number] }) => {
                calls.push(data);
                return data;
              },
            },
          },
        },
      ],
    }).compile();

    service = moduleRef.get(LlmService);
  });

  const request = {
    purpose: "diagnosis" as const,
    system: "diagnose",
    user: "Gateway reason: payment_card_expired. Instrument: card.",
  };

  it("returns validated output on a well-formed reply", async () => {
    const result = await service.structured(request, diagnosisSchema);

    expect(result.value.root_cause).toBe("CARD_EXPIRED");
    expect(result.attempts).toBe(1);
  });

  it("meters every call against its case", async () => {
    await service.structured(request, diagnosisSchema, { caseId: 1042 });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ purpose: "diagnosis", caseId: 1042 });
    expect(calls[0].tokensIn).toBeGreaterThan(0);
    expect(calls[0].projectedCostPaise).toBeGreaterThanOrEqual(0);
  });

  it("retries once when the model returns prose instead of JSON", async () => {
    let attempt = 0;
    driver.setOverride("diagnosis", () => {
      attempt += 1;
      return attempt === 1
        ? "I'm afraid I can't determine that."
        : JSON.stringify({
            root_cause: "INSUFFICIENT_FUNDS",
            confidence: 0.8,
            reasoning: "Balance was short.",
            evidence: ["balance"],
          });
    });

    const result = await service.structured(request, diagnosisSchema);

    expect(result.attempts).toBe(2);
    expect(result.value.root_cause).toBe("INSUFFICIENT_FUNDS");
    // Both attempts are billed: a failed call still consumed tokens.
    expect(calls).toHaveLength(2);
  });

  it("throws rather than returning unvalidated output after two failures", async () => {
    driver.setOverride("diagnosis", () => "still not JSON");

    await expect(service.structured(request, diagnosisSchema)).rejects.toThrow(LlmSchemaError);
    expect(calls).toHaveLength(2);
  });

  it("rejects a root cause outside the vocabulary", async () => {
    driver.setOverride("diagnosis", () =>
      JSON.stringify({
        root_cause: "CUSTOMER_CHANGED_THEIR_MIND",
        confidence: 0.9,
        reasoning: "Invented a category.",
        evidence: [],
      }),
    );

    await expect(service.structured(request, diagnosisSchema)).rejects.toThrow(LlmSchemaError);
  });

  it("rejects a confidence outside 0..1", async () => {
    driver.setOverride("diagnosis", () =>
      JSON.stringify({
        root_cause: "UNKNOWN",
        confidence: 1.4,
        reasoning: "Overconfident.",
        evidence: [],
      }),
    );

    await expect(service.structured(request, diagnosisSchema)).rejects.toThrow(LlmSchemaError);
  });

  it("rejects extra keys, because an improvising model must not pass silently", async () => {
    driver.setOverride("diagnosis", () =>
      JSON.stringify({
        root_cause: "UNKNOWN",
        confidence: 0.4,
        reasoning: "Fine.",
        evidence: [],
        recommended_action: "issue a refund",
      }),
    );

    await expect(service.structured(request, diagnosisSchema)).rejects.toThrow(LlmSchemaError);
  });
});

describe("FakeLlmDriver", () => {
  const driver = new FakeLlmDriver();

  it("is deterministic — identical prompts give identical replies", async () => {
    const a = await driver.complete({ purpose: "diagnosis", system: "s", user: "timeout at gateway" });
    const b = await driver.complete({ purpose: "diagnosis", system: "s", user: "timeout at gateway" });

    expect(a.text).toBe(b.text);
    expect(a.tokensIn).toBe(b.tokensIn);
  });

  it("reads legible evidence out of the prompt", async () => {
    const response = await driver.complete({
      purpose: "diagnosis",
      system: "s",
      user: "Gateway reason: payment_upi_collect_timeout",
    });

    expect(JSON.parse(response.text).root_cause).toBe("BANK_GATEWAY_DEGRADED");
  });

  it("returns low-confidence UNKNOWN when the signal says nothing", async () => {
    const response = await driver.complete({
      purpose: "diagnosis",
      system: "s",
      user: "Gateway reason: qzx_9931",
    });
    const parsed = JSON.parse(response.text);

    expect(parsed.root_cause).toBe("UNKNOWN");
    expect(parsed.confidence).toBeLessThan(0.6);
  });

  it("never invents a cause outside the vocabulary", async () => {
    for (const text of ["random noise", "expired card", "balance short", "mandate revoked"]) {
      const response = await driver.complete({ purpose: "diagnosis", system: "s", user: text });
      expect(() => diagnosisSchema.parse(JSON.parse(response.text))).not.toThrow();
    }
  });
});
