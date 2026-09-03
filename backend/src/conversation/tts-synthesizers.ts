import type { Turn } from "../channels/channel-adapter.interface";
import type { SynthesisedClip, TtsSynthesizer } from "./voice-audio.service";

/**
 * The two voices behind the recording.
 *
 * Both are kept out of the constructor path: `msedge-tts` opens a websocket
 * on first use and the Sarvam client needs a key, and neither belongs in a
 * process that has telephony switched off. Everything here is reached only
 * when `VOICE_TTS` names it.
 */

/** Edge neural voices, one pair per language, Boa always the first. */
const EDGE_VOICES: Record<string, { BOA: string; CUSTOMER: string }> = {
  "hi-IN": { BOA: "hi-IN-SwaraNeural", CUSTOMER: "hi-IN-MadhurNeural" },
  "en-IN": { BOA: "en-IN-NeerjaNeural", CUSTOMER: "en-IN-PrabhatNeural" },
};

const EDGE_TTS_PACKAGE = "msedge-tts";

type EdgeModule = {
  MsEdgeTTS: new () => {
    setMetadata(voice: string, format: string): Promise<void>;
    toStream(text: string): { audioStream: NodeJS.ReadableStream };
  };
  OUTPUT_FORMAT: Record<string, string>;
};

/**
 * Free, keyless, and not a contract: Microsoft can change the endpoint any
 * day. The fallback when it does is the browser's own synthesis, which the
 * player already has.
 */
export class EdgeTtsSynthesizer implements TtsSynthesizer {
  readonly provider = "edge-tts";

  constructor(
    // A runtime specifier, so the package is resolved when the lane is used
    // rather than at compile time: a build with VOICE_TTS=off must not need it.
    private readonly load: () => Promise<EdgeModule> = () =>
      import(EDGE_TTS_PACKAGE) as Promise<EdgeModule>,
  ) {}

  async synthesize(text: string, speaker: Turn["speaker"], language: string): Promise<SynthesisedClip> {
    const { MsEdgeTTS, OUTPUT_FORMAT } = await this.load();
    const voices = EDGE_VOICES[language] ?? EDGE_VOICES["en-IN"];

    const tts = new MsEdgeTTS();
    await tts.setMetadata(voices[speaker], OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(text);

    const chunks: Buffer[] = [];
    for await (const chunk of audioStream as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));

    return { audio: Buffer.concat(chunks), format: "mp3" };
  }
}

export const SARVAM_TTS_API = "https://api.sarvam.ai/text-to-speech";
export const SARVAM_MODEL = "bulbul:v3";
export const SARVAM_SPEAKERS = { BOA: "priya", CUSTOMER: "rahul" } as const;

/**
 * Sarvam's Bulbul, the Indic-first option when a key is present.
 *
 * Written against the published request shape and not yet exercised against
 * the service in this build — the owner had no key at the time — so it is
 * labelled as such in DECISIONS (D-126) rather than presented as verified.
 */
export class SarvamTtsSynthesizer implements TtsSynthesizer {
  readonly provider = "sarvam-bulbul";

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async synthesize(text: string, speaker: Turn["speaker"], language: string): Promise<SynthesisedClip> {
    const response = await this.fetchImpl(SARVAM_TTS_API, {
      method: "POST",
      headers: { "api-subscription-key": this.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        inputs: [text],
        target_language_code: language === "hi-IN" ? "hi-IN" : "en-IN",
        // bulbul:v2 was retired by Sarvam on 2026-09-03 with a 400 on every
        // call, and its speakers do not exist on v3 — the service names the
        // v3 roster in that error. Priya and Rahul are the v3 voices closest
        // to the pair that shipped (B-92).
        speaker: speaker === "BOA" ? SARVAM_SPEAKERS.BOA : SARVAM_SPEAKERS.CUSTOMER,
        model: SARVAM_MODEL,
        speech_sample_rate: 22050,
      }),
    });

    if (!response.ok) {
      throw new Error(`Sarvam ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }

    const { audios } = (await response.json()) as { audios?: string[] };
    if (!audios?.[0]) throw new Error("Sarvam returned no audio");

    return { audio: Buffer.from(audios[0], "base64"), format: "wav" };
  }
}
