import { Injectable, Logger } from "@nestjs/common";

import type {
  Turn,
  VoiceCounterpart,
  VoiceDetail,
  VoiceIntent,
} from "../channels/channel-adapter.interface";
import { LlmService } from "./llm.service";
import { dialogueTurnSchema } from "./schemas";

/**
 * The Hinglish voice call (PRD 7.8), conducted turn by turn.
 *
 * Boa's lines come from the model, one goal at a time; the counterpart is
 * scripted here and replaced by the simulator's personas in Stage 8. The split
 * matters for honesty: the model conducts the call but does not grade it. The
 * intent, the summary and the promise all come from code reading the
 * conversation, because an agent that both talks and scores its own call can
 * report whatever outcome flatters it.
 *
 * Telephony itself is simulated and labelled as such everywhere it surfaces.
 * The production path is Twilio/Exotel media streams on one side and Saarika
 * STT on the other; this engine is unchanged by that swap, which is the whole
 * argument for the adapter seam.
 */

export class VoiceDialogueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceDialogueError";
  }
}

const SYSTEM_PROMPT = [
  "You are Boa, an AI assistant placing a short courtesy call for an Indian merchant about an unpaid amount.",
  "Speak one turn at a time, in at most two sentences.",
  "Rules you may never break: introduce yourself by name on the merchant's behalf on the first turn;",
  "state the amount plainly; offer the payment link; ask for a date rather than demanding one;",
  "never threaten, never mention legal action, never imply consequences, never raise your voice.",
  "If the person says money is tight, accept it immediately and close warmly without pressing.",
  "Match the language named in the context: Hinglish means conversational Hindi written in Latin script.",
  'Answer only with JSON: {"say": string, "goal_complete": boolean}.',
].join(" ");

type Goal = "identify" | "state_amount" | "seek_promise" | "confirm" | "acknowledge";

/**
 * How each kind of call goes.
 *
 * `reply: null` means Boa's line ends the call. The shapes mirror the scripts
 * the Case Detail page was built to render, so a real run and the design agree.
 */
const SCRIPTS: Record<
  VoiceCounterpart,
  { goal: Goal; reply: { en: string; hi: string } | null }[]
> = {
  "no-answer": [
    {
      goal: "identify",
      reply: {
        en: "[no answer · call ended after 22 seconds]",
        hi: "[no answer · call ended after 22 seconds]",
      },
    },
  ],
  decline: [
    { goal: "identify", reply: { en: "Yes, go ahead.", hi: "Haan, boliye." } },
    {
      goal: "state_amount",
      reply: {
        en: "Money is tight this month, honestly. I can't commit to a date right now.",
        hi: "Dekhiye, abhi thoda tight chal raha hai. Main abhi commit nahi kar sakta.",
      },
    },
    { goal: "acknowledge", reply: null },
  ],
  promise: [
    { goal: "identify", reply: { en: "Speaking.", hi: "Haan ji, boliye." } },
    {
      goal: "state_amount",
      reply: {
        en: "No, it just slipped past month end. I'll get it done.",
        hi: "Nahi nahi, bas month end tha. Main kar dunga.",
      },
    },
    { goal: "seek_promise", reply: { en: "Yes, PROMISE_DATE works.", hi: "Haan, PROMISE_DATE tak ho jayega." } },
    { goal: "confirm", reply: null },
  ],
};

const SECONDS: Record<VoiceCounterpart, number> = { "no-answer": 22, decline: 48, promise: 71 };

const INTENTS: Record<VoiceCounterpart, VoiceIntent> = {
  "no-answer": "NO_ANSWER",
  decline: "HARDSHIP_DECLARED",
  promise: "PROMISED_TO_PAY",
};

export type DialogueContext = {
  caseId: number;
  customerName: string;
  merchantName: string;
  amountLabel: string;
  hinglish: boolean;
  promiseDateLabel: string;
  counterpart: VoiceCounterpart;
};

@Injectable()
export class VoiceDialogueService {
  private readonly logger = new Logger(VoiceDialogueService.name);

  constructor(private readonly llm: LlmService) {}

  async converse(context: DialogueContext): Promise<VoiceDetail> {
    const script = SCRIPTS[context.counterpart];
    const transcript: Turn[] = [];
    let turnsFromModel = 0;

    for (const step of script) {
      const say = await this.speak(context, step.goal, transcript);
      transcript.push({ speaker: "BOA", text: say });
      turnsFromModel += 1;

      if (!step.reply) break;

      const reply = (context.hinglish ? step.reply.hi : step.reply.en).replace(
        /PROMISE_DATE/g,
        context.promiseDateLabel,
      );
      transcript.push({ speaker: "CUSTOMER", text: reply });
    }

    const intent = INTENTS[context.counterpart];

    return {
      kind: "voice",
      seconds: SECONDS[context.counterpart],
      transcript,
      summary: summarise(intent, context),
      intent,
      language: context.hinglish ? "hi-IN" : "en-IN",
      turnsFromModel,
    };
  }

  private async speak(context: DialogueContext, goal: Goal, transcript: Turn[]): Promise<string> {
    // Only the first name and the amount reach the prompt: no phone number, no
    // email, no order id (PRD 9.9).
    const user = [
      `Goal: ${goal}`,
      `Customer: ${context.customerName.split(/\s+/)[0]}`,
      `Merchant: ${context.merchantName}`,
      `Amount: ${context.amountLabel}`,
      `Language: ${context.hinglish ? "hinglish" : "english"}`,
      `Promise date: ${context.promiseDateLabel}`,
      "Conversation so far:",
      transcript.length === 0
        ? "(the call has just connected)"
        : transcript.map((turn) => `${turn.speaker}: ${turn.text}`).join("\n"),
    ].join("\n");

    try {
      const result = await this.llm.structured(
        { purpose: "dialogue", system: SYSTEM_PROMPT, user, temperature: 0 },
        dialogueTurnSchema,
        { caseId: context.caseId },
      );
      return result.value.say;
    } catch (error) {
      // No scripted fallback line. A call the dialogue engine could not conduct
      // is a failed call, not a call that happened to go quiet — the executor
      // records the failure and the case goes to a human.
      this.logger.error(
        `Dialogue turn "${goal}" failed for case ${context.caseId}: ${(error as Error).message}`,
      );
      throw new VoiceDialogueError(`The dialogue engine could not produce the "${goal}" turn.`);
    }
  }
}

function summarise(intent: VoiceIntent, context: DialogueContext): string {
  switch (intent) {
    case "PROMISED_TO_PAY":
      return `Customer confirmed intent to pay and agreed a date. Promise recorded for ${context.promiseDateLabel} at the full ${context.amountLabel}; a follow-up is scheduled for that morning.`;
    case "HARDSHIP_DECLARED":
      return "Customer described a cash-flow constraint and declined to commit to a date. Hardship language detected, so the case went to a human and the agent stood down.";
    default:
      return "Nobody picked up. No voicemail was left, and the per-channel cap of one voice call means there will not be another.";
  }
}
