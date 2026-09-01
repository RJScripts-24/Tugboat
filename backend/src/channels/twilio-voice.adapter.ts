import { Inject, Injectable, Logger } from "@nestjs/common";

import { AppConfigService } from "../config/app-config.service";
import { VoiceAudioService } from "../conversation/voice-audio.service";
import { VoiceDialogueService, type LiveDialogueContext } from "../conversation/voice-dialogue.service";
import type { GatePass } from "../policy/gate-pass";
import {
  FETCH,
  type ChannelAdapter,
  type ChannelSendResult,
  type Fetch,
  type SendRequest,
  type Turn,
} from "./channel-adapter.interface";
import { voiceCallId } from "./channel-refs";
import { VoiceCallsService } from "./voice-calls.service";

const inr = (paise: number) =>
  new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(paise / 100));

export function twilioCallsUrl(accountSid: string): string {
  return `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`;
}

/**
 * A real call through Twilio Programmable Voice — the customer's phone rings.
 *
 * The adapter places the call and returns; the conversation itself is
 * conducted turn by turn over Twilio's webhooks (`VoiceController`), with
 * Boa's lines from the dialogue engine and the customer's from speech
 * recognition, and the outcome lands on the case when the line drops. The
 * result carries `pending: true` so the executor records a call *placed*, not
 * a call decided (D-144).
 */
@Injectable()
export class TwilioVoiceAdapter implements ChannelAdapter {
  readonly channel = "VOICE" as const;
  readonly mode = "real" as const;
  private readonly logger = new Logger(TwilioVoiceAdapter.name);

  constructor(
    private readonly config: AppConfigService,
    @Inject(FETCH) private readonly fetchImpl: Fetch,
    private readonly dialogue: VoiceDialogueService,
    private readonly audio: VoiceAudioService,
    private readonly calls: VoiceCallsService,
  ) {}

  async send(pass: GatePass, request: SendRequest): Promise<ChannelSendResult> {
    const twilio = this.config.twilio;
    if (!twilio?.voiceFrom) {
      throw new Error("Twilio voice is not configured: TWILIO_VOICE_FROM is missing");
    }

    const callId = voiceCallId(pass.caseId, request.attempt);
    const language = request.copy.hinglish ? "hi-IN" : "en-IN";
    const context: LiveDialogueContext = {
      caseId: pass.caseId,
      customerName: request.copy.customerName,
      merchantName: request.copy.merchantName,
      amountLabel: `₹${inr(request.copy.amountPaise)}`,
      hinglish: request.copy.hinglish,
      promiseDateLabel: request.promiseDateLabel ?? "Friday",
    };

    // The opening line is produced before the phone rings, so the first TwiML
    // fetch — which arrives within a second of the call being created — has
    // something to say.
    const opening = await this.dialogue.liveTurn(context, []);
    const transcript: Turn[] = [{ speaker: "BOA", text: opening.say }];
    await this.calls.open({ id: callId, caseId: pass.caseId, attempt: request.attempt, context, transcript });
    await this.audio.renderTurn(callId, 1, opening.say, language);

    const base = this.config.publicApiUrl;
    const form = new URLSearchParams({
      To: request.to,
      From: twilio.voiceFrom,
      Url: `${base}/voice/twiml/${callId}`,
      Method: "POST",
      StatusCallback: `${base}/voice/status/${callId}`,
      StatusCallbackMethod: "POST",
      Record: "true",
      RecordingStatusCallback: `${base}/voice/recording/${callId}`,
      RecordingStatusCallbackMethod: "POST",
      Timeout: "40",
    });

    const auth = Buffer.from(`${twilio.accountSid}:${twilio.authToken}`).toString("base64");
    const response = await this.fetchImpl(twilioCallsUrl(twilio.accountSid), {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });

    const payload = (await response.json().catch(() => ({}))) as { sid?: string; message?: string };
    if (!response.ok) {
      await this.calls.setStatus(callId, "failed");
      throw new Error(`Twilio voice answered ${response.status}: ${payload.message ?? "unknown error"}`);
    }

    await this.calls.dialed(callId, String(payload.sid ?? ""));
    this.logger.log(`Call ${callId} placed through Twilio (${payload.sid ?? "no sid"})`);

    return {
      channelRef: callId,
      mode: this.mode,
      // Settled from the call's real duration when the line drops.
      costPaise: 0,
      detail: {
        kind: "voice",
        seconds: 0,
        transcript,
        summary: "Call placed through Twilio — the conversation is arriving over the voice webhooks",
        intent: "IN_PROGRESS",
        language,
        turnsFromModel: 1,
        audioUrl: null,
        recording: null,
        pending: true,
      },
    };
  }
}
