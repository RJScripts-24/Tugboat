import { Injectable, Logger } from "@nestjs/common";

import type {
  Turn,
  VoiceCounterpart,
  VoiceDetail,
  VoiceIntent,
} from "../channels/channel-adapter.interface";
import { LlmService } from "./llm.service";
import { dialogueTurnSchema, liveTurnSchema } from "./schemas";

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

/** A real call has no scripted counterpart: the customer answers for themselves. */
export type LiveDialogueContext = Omit<DialogueContext, "counterpart">;

export type LiveTurn = {
  say: string;
  endCall: boolean;
  intent: "PROMISED_TO_PAY" | "HARDSHIP_DECLARED" | "UNDECIDED";
  /** The day the customer named, YYYY-MM-DD, or null when they named none (D-152). */
  promiseDate: string | null;
};

/**
 * The live call has its own system prompt rather than the scripted one plus an
 * addendum: a model shown two JSON shapes answers with whichever it read last,
 * and a turn that fails its schema mid-call is a hang-up (B-72).
 */
const LIVE_SYSTEM_PROMPT = [
  "You are Boa, an AI assistant on a live phone call for an Indian merchant about an unpaid amount.",
  "Speak one turn at a time, in at most two sentences.",
  "Rules you may never break: introduce yourself by name on the merchant's behalf on the first turn;",
  "state the amount plainly; ask for a date rather than demanding one;",
  "never threaten, never mention legal action, never imply consequences, never raise your voice.",
  "If the person says money is tight, accept it immediately and close warmly without pressing.",
  "Match the language named in the context: Hinglish means conversational Hindi written in Latin script.",
  "Answer only with JSON of exactly this shape and nothing else:",
  '{"say": string, "end_call": boolean, "intent": "PROMISED_TO_PAY" | "HARDSHIP_DECLARED" | "UNDECIDED", "promise_date": "YYYY-MM-DD" | null}',
].join(" ");

const LIVE_ADDENDUM = [
  "",
  "This is a LIVE phone call. The customer's words arrive from speech recognition and may be garbled, partial or empty.",
  "Reply with ONE short spoken line — at most two sentences. Work through, in order: greet and confirm who you are speaking to;",
  "state the pending amount plainly; ask whether they can pay and by when; if they name a day, confirm it and say you are sending the payment link to their WhatsApp now;",
  "if they cannot pay or describe hardship, acknowledge it without any pressure and close warmly; if they ask you to stop calling, apologise and close.",
  "Never threaten, never mention fees, penalties or consequences.",
  "Set end_call to true once a date has been agreed, or they have declined, or they asked you to stop, or this is your fifth line.",
  "Set intent to PROMISED_TO_PAY once a date has been agreed, HARDSHIP_DECLARED when they cannot pay or asked you to stop, otherwise UNDECIDED.",
  "Set promise_date to the day THE CUSTOMER named, resolved against Today in the context and written as YYYY-MM-DD.",
  "\"aaj\", \"aaj raat\" or \"tonight\" is Today. \"kal\" is the day after Today. A weekday name is the next such day.",
  "Use the date you suggested ONLY if they agreed to it in their own words. If no day was named, set promise_date to null.",
].join("\n");

/**
 * Today, in IST, as YYYY-MM-DD.
 *
 * The model has to resolve "aaj raat ko" against something, and a live call
 * happens in real time by definition — so this is the wall clock rather than
 * the batch clock, and the arithmetic is fixed-offset for the same reason the
 * quiet-hours check is (D-44).
 */
function istDate(at: Date): string {
  return new Date(at.getTime() + 5.5 * 60 * 60_000).toISOString().slice(0, 10);
}

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

  /**
   * The next line on a real call, given everything said so far (D-144).
   */
  async liveTurn(context: LiveDialogueContext, transcript: Turn[]): Promise<LiveTurn> {
    const user = [
      "Mode: live",
      `Customer: ${context.customerName.split(/\s+/)[0]}`,
      `Merchant: ${context.merchantName}`,
      `Amount: ${context.amountLabel}`,
      `Language: ${context.hinglish ? "hinglish" : "english"}`,
      `Today: ${istDate(new Date())}`,
      `Date you may suggest if they ask for one: ${context.promiseDateLabel}`,
      "Conversation so far:",
      transcript.length === 0
        ? "(the call has just connected)"
        : transcript.map((turn) => `${turn.speaker}: ${turn.text}`).join("\n"),
    ].join("\n");

    try {
      const result = await this.llm.structured(
        { purpose: "dialogue", system: LIVE_SYSTEM_PROMPT + LIVE_ADDENDUM, user, temperature: 0 },
        liveTurnSchema,
        { caseId: context.caseId },
      );
      return {
        say: result.value.say,
        endCall: result.value.end_call,
        intent: result.value.intent,
        promiseDate: result.value.promise_date ?? null,
      };
    } catch (error) {
      this.logger.error(`Live dialogue turn failed for case ${context.caseId}: ${(error as Error).message}`);
      throw new VoiceDialogueError("The dialogue engine could not produce the next line of the call.");
    }
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
