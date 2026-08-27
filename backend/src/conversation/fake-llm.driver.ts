import { createHash } from "node:crypto";

import { Injectable } from "@nestjs/common";

import type { LlmDriver, LlmPurpose, LlmRequest, LlmResponse } from "./llm-driver.interface";

/**
 * A deterministic stand-in for a language model.
 *
 * This is the default lane, not a test double bolted on afterwards, for three
 * reasons: the batch evidence must be reproducible (identical seed, identical
 * numbers), a fresh clone must run the whole agent loop with no API keys, and
 * developing against a live model burns free-tier quota on noise.
 *
 * It behaves like a model rather than like an oracle: it reads the prompt for
 * evidence, is right when the evidence is clear, and returns a low-confidence
 * UNKNOWN when it is not — which is what exercises the escalation path. It has
 * no access to the simulator's ground truth, so nothing it produces can flatter
 * the accuracy figures.
 */
@Injectable()
export class FakeLlmDriver implements LlmDriver {
  readonly provider = "fake";

  /**
   * Lets a test force a specific reply — including a malformed one, which is
   * how the "model returned garbage" path is proven rather than assumed.
   */
  private overrides = new Map<LlmPurpose, (request: LlmRequest) => string>();

  modelFor(purpose: LlmPurpose): string {
    return `fake-${purpose}`;
  }

  setOverride(purpose: LlmPurpose, responder: (request: LlmRequest) => string): void {
    this.overrides.set(purpose, responder);
  }

  clearOverrides(): void {
    this.overrides.clear();
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const override = this.overrides.get(request.purpose);
    const text = override ? override(request) : this.respond(request);

    return {
      text,
      provider: this.provider,
      model: this.modelFor(request.purpose),
      // Realistic magnitudes so cost metering has something meaningful to
      // aggregate; derived from the prompt so a rerun reports the same spend.
      tokensIn: estimateTokens(`${request.system} ${request.user}`),
      tokensOut: estimateTokens(text),
      latencyMs: 2 + (hash(request.user) % 40),
    };
  }

  private respond(request: LlmRequest): string {
    switch (request.purpose) {
      case "diagnosis":
        return JSON.stringify(this.diagnose(request.user));
      case "sentiment":
        return JSON.stringify(this.sentiment(request.user));
      case "dialogue":
        return JSON.stringify(this.dialogue(request.user));
      default:
        return JSON.stringify({ text: "" });
    }
  }

  /**
   * Reads the prompt for the same evidence a real model would weigh.
   *
   * Confidence is derived from the prompt's hash inside a band, so it varies
   * case to case without varying between runs — which keeps the batch
   * reproducible while still producing a spread of confidences to threshold on.
   */
  private diagnose(prompt: string) {
    const text = evidenceText(prompt);

    const candidates: { cause: string; evidence: string[]; hit: boolean }[] = [
      {
        cause: "CARD_EXPIRED",
        evidence: ["expiry", "expired", "card"],
        hit: /expir/.test(text) && /card/.test(text),
      },
      {
        cause: "INSUFFICIENT_FUNDS",
        evidence: ["balance", "funds", "declined"],
        hit: /balance|funds|nsf/.test(text),
      },
      {
        cause: "BANK_GATEWAY_DEGRADED",
        evidence: ["timeout", "gateway", "upstream"],
        hit: /timeout|gateway|upstream|unavailable/.test(text),
      },
      {
        cause: "MANDATE_REVOKED",
        evidence: ["mandate", "revoked", "authorisation"],
        hit: /mandate|revok|de-?register/.test(text),
      },
      {
        cause: "CUSTOMER_DISTRACTED",
        evidence: ["abandoned", "no error", "idle"],
        hit: /abandon|idle|no gateway error|past its due date/.test(text),
      },
    ];

    const match = candidates.find((candidate) => candidate.hit);

    if (!match) {
      // Nothing legible in the signal. A real model would guess here; this one
      // reports low confidence so the floor sends it to a human instead.
      return {
        root_cause: "UNKNOWN",
        confidence: round(0.28 + (hash(prompt) % 22) / 100),
        reasoning:
          "The reason code is unmapped and the surrounding signals do not agree on a cause.",
        evidence: ["unmapped reason code"],
      };
    }

    return {
      root_cause: match.cause,
      confidence: round(0.62 + (hash(prompt) % 27) / 100),
      reasoning: `The signal points to ${match.cause.toLowerCase().replace(/_/g, " ")}, on the wording of the gateway's own account of the failure.`,
      evidence: match.evidence,
    };
  }

  private sentiment(prompt: string) {
    const text = prompt.toLowerCase();

    if (/\bstop\b|unsubscribe|band karo|बंद करो/.test(text)) {
      return { sentiment: "opt-out", score: -1, reasoning: "Opt-out keyword present." };
    }
    if (/tight|can'?t afford|hardship|paisa nahi|no money|majboori|dikkat/.test(text)) {
      return { sentiment: "negative", score: -0.78, reasoning: "Financial hardship expressed." };
    }
    // Anger, kept apart from hardship. Both are negative and they lead to
    // different places: hardship escalates to a person, hostility halts the
    // case. A classifier that could only see the first left the
    // negative-sentiment stopping rule unreachable on every batch.
    if (
      /harassment|stop chasing|fed up|not paying|bahut messages|pareshaan|mat karo|baar baar/.test(
        text,
      )
    ) {
      return { sentiment: "negative", score: -0.84, reasoning: "Hostility toward being chased." };
    }
    if (/paid|kar diya|done|paying now|bhej diya/.test(text)) {
      return { sentiment: "positive", score: 0.71, reasoning: "Customer indicates payment." };
    }

    return { sentiment: "neutral", score: 0.05, reasoning: "Acknowledgement without commitment." };
  }

  /**
   * One line of the voice call, chosen by the goal the prompt names.
   *
   * The script obeys the same rules the live system prompt gives Gemini:
   * introduce itself by name on the merchant's behalf, state the amount, offer
   * the link, seek a date, never threaten. It is a stand-in for a model, so it
   * reads the prompt's fields rather than being handed a lookup key.
   */
  private dialogue(prompt: string) {
    const goal = field(prompt, "Goal") ?? "identify";
    const who = (field(prompt, "Customer") ?? "there").split(/\s+/)[0];
    const merchant = field(prompt, "Merchant") ?? "the merchant";
    const amount = field(prompt, "Amount") ?? "the outstanding amount";
    const date = field(prompt, "Promise date") ?? "Friday";
    const hinglish = (field(prompt, "Language") ?? "english").toLowerCase().startsWith("hi");

    const lines: Record<string, string> = hinglish
      ? {
          identify: `Namaste, main Boa bol rahi hoon, ${merchant} ki taraf se. Kya main ${who} se baat kar rahi hoon?`,
          state_amount: `Aapka ${amount} ka payment abhi tak pending hai. Koi issue tha kya?`,
          seek_promise: `Bilkul. Kya main ${date} tak expect kar sakti hoon? Payment link main WhatsApp par bhej deti hoon.`,
          confirm: `Theek hai, maine ${date}, ${amount} note kar liya hai. Link bhej rahi hoon. Dhanyavaad.`,
          acknowledge:
            "Bilkul samajh sakti hoon, main koi pressure nahi daalungi. Jab aap ready ho, link aapke WhatsApp par hai. Dhanyavaad.",
        }
      : {
          identify: `Hello, this is Boa calling on behalf of ${merchant}. Am I speaking with ${who}?`,
          state_amount: `There's ${amount} still outstanding. Was there a problem with it?`,
          seek_promise: `Understood. May I note it for ${date}? I'll send the payment link on WhatsApp.`,
          confirm: `Noted — ${date}, ${amount}. Link on its way. Thank you.`,
          acknowledge:
            "That's completely fine — I won't push. The link stays live on your WhatsApp for whenever it suits. Thank you for your time.",
        };

    if ((field(prompt, "Mode") ?? "") === "live") return liveTurn(prompt, lines);

    return { say: lines[goal] ?? lines.identify, goal_complete: goal !== "identify" };
  }
}

/** Reads one `Label: value` line out of a prompt, the way a model reads its context. */
function field(prompt: string, label: string): string | null {
  const prefix = `${label}:`.toLowerCase();

  for (const line of prompt.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.toLowerCase().startsWith(prefix)) return trimmed.slice(prefix.length).trim();
  }

  return null;
}

/**
 * The values a diagnosis prompt carries, without its labels.
 *
 * This matters more than it looks: the prompt labels every line "Gateway error
 * code" and "Gateway reason", so scanning the whole prompt for the word
 * "gateway" matches every case ever sent and classifies all of them as a
 * gateway outage. A model reads the values; so does this.
 *
 * Falls back to the whole string when no labelled fields are present, so an
 * ad-hoc prompt still gets a sensible reading.
 */
function evidenceText(prompt: string): string {
  const values: string[] = [];

  for (const label of ["Gateway error code", "Gateway reason", "Instrument", "Case type"]) {
    const match = new RegExp(`^${label}:\\s*(.*)$`, "im").exec(prompt);
    if (match) values.push(match[1].trim());
  }

  if (values.length === 0) return prompt.toLowerCase();

  const degraded = /^Gateway-wide degradation currently detected:\s*yes$/im.test(prompt);
  if (degraded) values.push("gateway degradation in progress");

  return values.join(" ").toLowerCase();
}

function hash(text: string): number {
  return createHash("sha256").update(text).digest().readUInt32BE(0);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Rough but stable: about four characters per token, which is the usual English ratio. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * A real call, offline: Boa's next line is chosen from what the customer last
 * said, the way the live prompt asks the model to (D-144).
 */
function liveTurn(prompt: string, lines: Record<string, string>) {
  const conversation = prompt.split("Conversation so far:")[1] ?? "";
  const boaTurns = (conversation.match(/^BOA:/gm) ?? []).length;
  const said = [...conversation.matchAll(/^CUSTOMER: (.*)$/gm)].map((m) => m[1].toLowerCase());
  const last = said[said.length - 1] ?? "";

  const hardship = /(nahi|cannot|can't|cant|no money|paise nahi|stop|band karo|don't call|dont call)/.test(last);
  const promise = /(kal|tomorrow|friday|monday|tuesday|wednesday|thursday|saturday|sunday|salary|pay kar|karunga|karungi|will pay|haan|yes|\bok\b)/.test(last);
  const intent = hardship ? "HARDSHIP_DECLARED" : promise ? "PROMISED_TO_PAY" : "UNDECIDED";

  const goal =
    boaTurns === 0
      ? "identify"
      : boaTurns === 1
        ? "state_amount"
        : intent === "PROMISED_TO_PAY"
          ? "confirm"
          : intent === "HARDSHIP_DECLARED"
            ? "acknowledge"
            : "seek_promise";

  return {
    say: lines[goal] ?? lines.identify,
    end_call: (boaTurns >= 2 && intent !== "UNDECIDED") || boaTurns >= 5,
    intent,
  };
}
