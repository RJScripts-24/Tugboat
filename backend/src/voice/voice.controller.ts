import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
} from "@nestjs/common";
import type { Request, Response } from "express";

import { ExecutorService } from "../agent-core/executor.service";
import { Public } from "../auth/public.decorator";
import type { Turn } from "../channels/channel-adapter.interface";
import { contextOf, transcriptOf, VoiceCallsService } from "../channels/voice-calls.service";
import { AppConfigService } from "../config/app-config.service";
import { VoiceAudioService } from "../conversation/voice-audio.service";
import { VoiceDialogueService, type LiveTurn } from "../conversation/voice-dialogue.service";
import { twilioSignatureValid } from "./twilio-signature";

/** Boa never keeps a customer on the line past this many of her own turns. */
const MAX_BOA_TURNS = 6;
/** Two silences in a row is a voicemail or a dropped handset, not a conversation. */
const MAX_SILENCES = 2;
const CALL_ID = /^[A-Za-z0-9_-]{1,80}$/;
const CLIP_NAME = /^[A-Za-z0-9_-]{1,96}\.(mp3|wav)$/;

type TwilioForm = Record<string, string | undefined>;

/**
 * The webhooks a real call is made of (D-144).
 *
 * Twilio fetches `twiml/:callId` when the customer answers, posts what they
 * said to `turn/:callId` after each of Boa's lines, and reports the call's end
 * to `status/:callId` and its recording to `recording/:callId`. Every one is
 * public to the network and private to Twilio: the signature on each request
 * is checked against the auth token before a byte of it is believed.
 */
@Controller("voice")
export class VoiceController {
  private readonly logger = new Logger(VoiceController.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly calls: VoiceCallsService,
    private readonly dialogue: VoiceDialogueService,
    private readonly audio: VoiceAudioService,
    private readonly executor: ExecutorService,
  ) {}

  @Public()
  @Post("twiml/:callId")
  @HttpCode(200)
  @Header("Content-Type", "text/xml")
  async twiml(
    @Param("callId") callId: string,
    @Body() body: TwilioForm,
    @Req() request: Request,
  ): Promise<string> {
    this.verify(request, body);
    const call = await this.load(callId);
    const transcript = transcriptOf(call);
    const opening = [...transcript].reverse().find((turn) => turn.speaker === "BOA");
    if (!opening) return twiml("<Hangup/>");

    await this.calls.setStatus(callId, "talking");
    const index = transcript.filter((turn) => turn.speaker === "BOA").length;
    return this.prompt(callId, index, opening.text, contextOf(call).hinglish);
  }

  @Public()
  @Post("turn/:callId")
  @HttpCode(200)
  @Header("Content-Type", "text/xml")
  async turn(
    @Param("callId") callId: string,
    @Body() body: TwilioForm,
    @Query("silent") silent: string | undefined,
    @Req() request: Request,
  ): Promise<string> {
    this.verify(request, body);
    const call = await this.load(callId);
    const context = contextOf(call);
    const heard = (body.SpeechResult ?? "").trim();
    const transcript: Turn[] = [
      ...transcriptOf(call),
      { speaker: "CUSTOMER", text: heard || (silent === "1" ? "(silence)" : "(inaudible)") },
    ];

    const silences = transcript.filter(
      (turn) => turn.speaker === "CUSTOMER" && /^\((silence|inaudible)\)$/.test(turn.text),
    ).length;
    const boaTurnsSoFar = transcript.filter((turn) => turn.speaker === "BOA").length;

    // The engine failing mid-call must not become Twilio's "application error"
    // in the customer's ear: Boa closes politely and the case keeps what was
    // said (B-72). The failure is on the log, not on the line.
    let next: LiveTurn;
    try {
      next = await this.dialogue.liveTurn(context, transcript);
    } catch (error) {
      this.logger.error(`Call ${callId}: the dialogue engine failed mid-call — closing: ${(error as Error).message}`);
      next = { say: closingLine(context.hinglish), endCall: true, intent: "UNDECIDED", promiseDate: null };
    }
    transcript.push({ speaker: "BOA", text: next.say });
    const index = boaTurnsSoFar + 1;

    const ending = next.endCall || index >= MAX_BOA_TURNS || silences >= MAX_SILENCES;
    await this.calls.speak(callId, transcript, {
      status: ending ? "wrapping" : "talking",
      intent: next.intent,
      // The day the customer actually named, if this turn heard one (D-151).
      promisedFor: next.promiseDate ? istDay(next.promiseDate) : null,
    });

    if (ending) {
      const url = await this.audio.renderTurn(callId, index, next.say, context.hinglish ? "hi-IN" : "en-IN");
      return twiml(`${speak(url, next.say, context.hinglish)}<Hangup/>`);
    }
    return this.prompt(callId, index, next.say, context.hinglish);
  }

  @Public()
  @Post("status/:callId")
  @HttpCode(200)
  async status(
    @Param("callId") callId: string,
    @Body() body: TwilioForm,
    @Req() request: Request,
  ): Promise<{ ok: true }> {
    this.verify(request, body);
    const call = await this.load(callId);
    const answered = body.CallStatus === "completed";
    const seconds = Number.parseInt(body.CallDuration ?? "0", 10) || 0;
    this.logger.log(`Call ${callId} ended: ${body.CallStatus ?? "unknown"} after ${seconds}s`);

    await this.executor.completeVoiceCall(callId, {
      answered,
      seconds,
      audioUrl: answered && call.providerSid ? `${this.config.publicApiUrl}/media/voice/${callId}.mp3` : null,
      providerStatus: body.CallStatus ?? "unknown",
    });
    return { ok: true };
  }

  @Public()
  @Post("recording/:callId")
  @HttpCode(200)
  async recording(
    @Param("callId") callId: string,
    @Body() body: TwilioForm,
    @Req() request: Request,
  ): Promise<{ ok: true }> {
    this.verify(request, body);
    await this.load(callId);
    if (body.RecordingUrl) await this.calls.setRecording(callId, body.RecordingUrl);
    return { ok: true };
  }

  /**
   * One of Boa's lines, as audio, for Twilio's `<Play>`. Unauthenticated by
   * necessity — Twilio holds no session — and named by the call id, which is
   * unguessable; it carries one sentence of one call and nothing else.
   */
  @Public()
  @Get("audio/:file")
  async clip(
    @Param("file") file: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    if (!CLIP_NAME.test(file)) throw new NotFoundException({ error: "No such clip." });
    const path = resolve(this.config.voiceAudioDir, file);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) throw new NotFoundException({ error: "No such clip." });
    response.setHeader("Content-Type", file.endsWith(".wav") ? "audio/wav" : "audio/mpeg");
    response.setHeader("Content-Length", String(info.size));
    return new StreamableFile(createReadStream(path));
  }

  /* ---------------------------------------------------------------- */

  private async prompt(callId: string, index: number, say: string, hinglish: boolean): Promise<string> {
    const language = hinglish ? "hi-IN" : "en-IN";
    const url = await this.audio.renderTurn(callId, index, say, language);
    const base = this.config.publicApiUrl;
    const action = `${base}/voice/turn/${callId}`;
    return twiml(
      `<Gather input="speech" language="${language}" speechTimeout="auto" timeout="6" action="${action}" method="POST">` +
        speak(url, say, hinglish) +
        `</Gather>` +
        `<Redirect method="POST">${action}?silent=1</Redirect>`,
    );
  }

  private async load(callId: string) {
    if (!CALL_ID.test(callId)) throw new NotFoundException({ error: "No such call." });
    const call = await this.calls.get(callId);
    if (!call) throw new NotFoundException({ error: "No such call." });
    return call;
  }

  private verify(request: Request, body: TwilioForm): void {
    const twilio = this.config.twilio;
    if (!twilio) throw new ForbiddenException({ error: "Twilio is not configured." });
    const url = `${this.config.publicApiUrl}${request.originalUrl}`;
    const signature = request.header("x-twilio-signature");
    if (!twilioSignatureValid(twilio.authToken, url, body ?? {}, signature)) {
      this.logger.warn(`Rejected an unsigned voice webhook for ${request.originalUrl}`);
      throw new ForbiddenException({ error: "Signature did not verify." });
    }
  }
}

/** What Boa says when she cannot say what she meant to. */
function closingLine(hinglish: boolean): string {
  return hinglish
    ? "Maaf kijiye, line mein kuch dikkat aa rahi hai. Payment link aapke WhatsApp par hai — jab aapko theek lage, wahan se kar dijiye. Dhanyavaad."
    : "Sorry, the line is giving us trouble. The payment link is on your WhatsApp whenever it suits you. Thank you.";
}

function twiml(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
}

/** The rendered clip when there is one; Twilio's own Indian voice otherwise. */
/**
 * A YYYY-MM-DD the model heard, as an instant.
 *
 * Anchored at 09:00 IST — the promise is a day, not a moment, and the follow-up
 * that reads it back wants the morning of that day rather than midnight UTC,
 * which is the previous evening in India.
 */
function istDay(day: string): Date {
  return new Date(`${day}T09:00:00+05:30`);
}

function speak(url: string | null, text: string, hinglish: boolean): string {
  if (url) return `<Play>${escapeXml(url)}</Play>`;
  return `<Say voice="Polly.Aditi" language="${hinglish ? "hi-IN" : "en-IN"}">${escapeXml(text)}</Say>`;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
