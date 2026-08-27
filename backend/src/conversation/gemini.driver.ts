import {
  LLM_TIMEOUT_MS,
  type LlmDriver,
  type LlmRequest,
  type LlmResponse,
} from "./llm-driver.interface";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

type GeminiResponse = {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
};

/**
 * Google AI Studio's free tier — the reasoning lane (PRD 5.3).
 *
 * Used for ambiguous diagnosis and the Hinglish dialogue, which are the two
 * places where judgement genuinely beats a lookup table.
 */
export class GeminiDriver implements LlmDriver {
  readonly provider = "gemini";

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  modelFor(): string {
    return this.model;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const started = Date.now();
    const user = request.repair ? `${request.user}\n\n${request.repair}` : request.user;

    const response = await fetch(`${ENDPOINT}/${this.model}:generateContent?key=${this.apiKey}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: request.system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: {
          temperature: request.temperature ?? 0,
          maxOutputTokens: request.maxTokens ?? 1024,
          // Asking for JSON at the API level removes most prose-around-the-JSON
          // failures before the schema ever has to reject one.
          responseMimeType: "application/json",
        },
      }),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Gemini ${response.status}: ${await response.text()}`);
    }

    const body = (await response.json()) as GeminiResponse;
    const text = body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";

    return {
      text,
      provider: this.provider,
      model: this.model,
      tokensIn: body.usageMetadata?.promptTokenCount ?? 0,
      tokensOut: body.usageMetadata?.candidatesTokenCount ?? 0,
      latencyMs: Date.now() - started,
    };
  }
}
