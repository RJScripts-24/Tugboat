import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Injectable, Logger } from "@nestjs/common";

import type { Turn } from "../channels/channel-adapter.interface";
import { AppConfigService } from "../config/app-config.service";

/**
 * The call as a recording (PRD 7.8).
 *
 * Telephony is simulated and says so; this is the one part of the voice
 * pipeline that becomes real at zero cost — each turn of the transcript is
 * synthesised, Boa and the customer in different voices, and the pieces are
 * stitched into one file the Case Detail player streams. Until it existed the
 * browser read the transcript aloud with whatever voice the machine had, and
 * the label beside the player said so.
 *
 * The synthesiser is an interface so the tests never touch the network and a
 * provider swap is one class. `edge` (Microsoft's neural voices through the
 * Edge endpoint) needs no key; `sarvam` needs one and is the Indic-first
 * choice when it is there. `off` renders nothing and the player falls back to
 * what it did before.
 */

export type SynthesisedClip = { audio: Buffer; format: "mp3" | "wav" };

export interface TtsSynthesizer {
  readonly provider: string;
  synthesize(text: string, speaker: Turn["speaker"], language: string): Promise<SynthesisedClip>;
}

/** Stage directions such as "[no answer · call ended after 22 seconds]" are not spoken. */
const STAGE_DIRECTION = /^\s*\[.*\]\s*$/;

@Injectable()
export class VoiceAudioService {
  private readonly logger = new Logger(VoiceAudioService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly synthesizer: TtsSynthesizer | null,
  ) {}

  get enabled(): boolean {
    return this.synthesizer !== null;
  }

  get provider(): string | null {
    return this.synthesizer?.provider ?? null;
  }

  /**
   * Renders the transcript and returns the URL the browser plays it from, or
   * null when rendering is off or fails — a call whose recording could not be
   * made is still a call, and the timeline must not lose it over a codec.
   */
  async render(callId: string, transcript: Turn[], language: string): Promise<string | null> {
    if (!this.synthesizer) return null;

    const spoken = transcript.filter((turn) => turn.text.trim() && !STAGE_DIRECTION.test(turn.text));
    if (spoken.length === 0) return null;

    try {
      const clips: SynthesisedClip[] = [];
      for (const turn of spoken) {
        clips.push(await this.synthesizer.synthesize(turn.text, turn.speaker, language));
      }

      const stitched = stitch(clips);
      const dir = resolve(this.config.voiceAudioDir);
      await mkdir(dir, { recursive: true });

      const file = `${safeName(callId)}.${stitched.format}`;
      await writeFile(resolve(dir, file), stitched.audio);

      return `${this.config.publicApiUrl}/media/voice/${file}`;
    } catch (error) {
      this.logger.warn(`Could not render a recording for ${callId}: ${(error as Error).message}`);
      return null;
    }
  }
}

export function safeName(callId: string): string {
  return callId.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * One file from many clips.
 *
 * MP3 is a stream of self-describing frames, so clips concatenate. WAV is a
 * header plus samples, so the data chunks are joined under the first clip's
 * header with the sizes rewritten — valid as long as every clip shares a
 * sample rate and width, which one provider on one voice family does.
 */
export function stitch(clips: SynthesisedClip[]): SynthesisedClip {
  if (clips.length === 0) throw new Error("Nothing to stitch");
  const format = clips[0].format;
  if (clips.some((clip) => clip.format !== format)) throw new Error("Mixed audio formats");

  if (format === "mp3") {
    return { format, audio: Buffer.concat(clips.map((clip) => clip.audio)) };
  }

  const data = clips.map((clip) => wavData(clip.audio));
  const body = Buffer.concat(data);
  const header = Buffer.from(clips[0].audio.subarray(0, 44));
  header.writeUInt32LE(36 + body.length, 4);
  header.writeUInt32LE(body.length, 40);
  return { format, audio: Buffer.concat([header, body]) };
}

/** The samples of a canonical 44-byte-header PCM WAV. */
function wavData(wav: Buffer): Buffer {
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("Not a RIFF/WAV clip");
  }
  return wav.subarray(44);
}
