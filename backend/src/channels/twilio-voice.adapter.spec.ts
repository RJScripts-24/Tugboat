import { testPass } from "../../test/gate-pass.fixture";
import type { AppConfigService } from "../config/app-config.service";
import type { VoiceAudioService } from "../conversation/voice-audio.service";
import type { VoiceDialogueService } from "../conversation/voice-dialogue.service";
import type { SendRequest } from "./channel-adapter.interface";
import { voiceCallId } from "./channel-refs";
import { TwilioVoiceAdapter, twilioCallsUrl } from "./twilio-voice.adapter";
import type { VoiceCallsService } from "./voice-calls.service";

type Call = { url: string; init: RequestInit };

function fakeFetch(status: number, body: unknown, calls: Call[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

const config = {
  publicApiUrl: "https://api.example.test",
  twilio: { accountSid: "AC1", authToken: "tok", whatsappFrom: "whatsapp:+1", voiceFrom: "+19348844920" },
} as unknown as AppConfigService;

const dialogue = {
  liveTurn: async () => ({ say: "Namaste, main Boa bol rahi hoon.", endCall: false, intent: "UNDECIDED" }),
} as unknown as VoiceDialogueService;

const audio = { renderTurn: async () => null } as unknown as VoiceAudioService;

function callsStore() {
  const log: string[] = [];
  const service = {
    open: async (input: { id: string }) => {
      log.push(`open:${input.id}`);
      return {};
    },
    dialed: async (id: string, sid: string) => {
      log.push(`dialed:${id}:${sid}`);
      return {};
    },
    setStatus: async (id: string, status: string) => {
      log.push(`status:${id}:${status}`);
      return {};
    },
  } as unknown as VoiceCallsService;
  return { service, log };
}

function request(): SendRequest {
  return {
    caseId: 1042,
    attempt: 3,
    to: "+917634847354",
    copy: {
      caseId: 1042,
      type: "PAYMENT_FAILED",
      rootCause: "CARD_EXPIRED",
      amountPaise: 249_900,
      customerName: "Rishabh",
      merchantName: "Demo Merchant",
      hinglish: true,
      attempt: 3,
    },
    promiseDateLabel: "Friday",
  };
}

describe("the Twilio voice adapter — a real call is placed, not decided (D-144)", () => {
  it("opens the call record, dials through Twilio with the webhooks, and returns a pending result", async () => {
    const calls: Call[] = [];
    const store = callsStore();
    const adapter = new TwilioVoiceAdapter(config, fakeFetch(201, { sid: "CAtwilio1" }, calls), dialogue, audio, store.service);

    const result = await adapter.send(testPass({ channel: "VOICE" }), request());
    const callId = voiceCallId(1042, 3);

    expect(result.mode).toBe("real");
    expect(result.channelRef).toBe(callId);
    expect(result.costPaise).toBe(0);
    expect(result.detail).toMatchObject({
      kind: "voice",
      pending: true,
      intent: "IN_PROGRESS",
      language: "hi-IN",
      transcript: [{ speaker: "BOA", text: "Namaste, main Boa bol rahi hoon." }],
    });

    expect(store.log).toEqual([`open:${callId}`, `dialed:${callId}:CAtwilio1`]);

    expect(calls[0].url).toBe(twilioCallsUrl("AC1"));
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("AC1:tok").toString("base64")}`);

    const form = new URLSearchParams(String(calls[0].init.body));
    expect(form.get("To")).toBe("+917634847354");
    expect(form.get("From")).toBe("+19348844920");
    expect(form.get("Url")).toBe(`https://api.example.test/voice/twiml/${callId}`);
    expect(form.get("StatusCallback")).toBe(`https://api.example.test/voice/status/${callId}`);
    expect(form.get("RecordingStatusCallback")).toBe(`https://api.example.test/voice/recording/${callId}`);
    expect(form.get("Record")).toBe("true");
  });

  it("fails the action rather than pretending when Twilio refuses the call", async () => {
    const calls: Call[] = [];
    const store = callsStore();
    const adapter = new TwilioVoiceAdapter(
      config,
      fakeFetch(400, { message: "The number +917634847354 is unverified." }, calls),
      dialogue,
      audio,
      store.service,
    );

    await expect(adapter.send(testPass({ channel: "VOICE" }), request())).rejects.toThrow(/unverified/);
    expect(store.log[store.log.length - 1]).toBe(`status:${voiceCallId(1042, 3)}:failed`);
  });

  it("refuses to run without a voice number", async () => {
    const adapter = new TwilioVoiceAdapter(
      { ...config, twilio: { ...config.twilio, voiceFrom: null } } as unknown as AppConfigService,
      fakeFetch(201, {}, []),
      dialogue,
      audio,
      callsStore().service,
    );
    await expect(adapter.send(testPass({ channel: "VOICE" }), request())).rejects.toThrow(/TWILIO_VOICE_FROM/);
  });
});
