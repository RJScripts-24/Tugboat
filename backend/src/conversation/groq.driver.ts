import type { LlmDriver, LlmRequest, LlmResponse } from "./llm-driver.interface";

const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

type GroqResponse = {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

/**
 * Groq's free tier — the fast, cheap lane (PRD 5.3).
 *
 * Message drafting, reply-sentiment classification, transcript summaries and
 * simulator persona roleplay: high volume, low stakes, sub-second.
 */
export class GroqDriver implements LlmDriver {
  readonly provider = "groq";

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  modelFor(): string {
    return this.model;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const started = Date.now();

    const messages = [
      { role: "system", content: request.system },
      { role: "user", content: request.user },
      ...(request.repair ? [{ role: "user", content: request.repair }] : []),
    ];

    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: request.temperature ?? 0,
        max_tokens: request.maxTokens ?? 1024,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      throw new Error(`Groq ${response.status}: ${await response.text()}`);
    }

    const body = (await response.json()) as GroqResponse;

    return {
      text: body.choices?.[0]?.message?.content ?? "",
      provider: this.provider,
      model: this.model,
      tokensIn: body.usage?.prompt_tokens ?? 0,
      tokensOut: body.usage?.completion_tokens ?? 0,
      latencyMs: Date.now() - started,
    };
  }
}
