import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AppConfigService } from "../config/app-config.service";
import { safeName, stitch, VoiceAudioService, type TtsSynthesizer } from "./voice-audio.service";

const TURNS = [
  { speaker: "BOA" as const, text: "Namaste Priya, Boa bol rahi hoon." },
  { speaker: "CUSTOMER" as const, text: "[no answer · call ended after 22 seconds]" },
  { speaker: "CUSTOMER" as const, text: "Haan, boliye." },
];

function wav(samples: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + samples, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(samples, 40);
  return Buffer.concat([header, Buffer.alloc(samples, 7)]);
}

describe("stitching clips", () => {
  it("concatenates MP3 frames as they are", () => {
    const out = stitch([
      { format: "mp3", audio: Buffer.from("aa") },
      { format: "mp3", audio: Buffer.from("bb") },
    ]);
    expect(out.format).toBe("mp3");
    expect(out.audio.toString()).toBe("aabb");
  });

  it("joins WAV samples under one header with the sizes rewritten", () => {
    const out = stitch([
      { format: "wav", audio: wav(10) },
      { format: "wav", audio: wav(20) },
    ]);
    expect(out.audio.length).toBe(44 + 30);
    expect(out.audio.readUInt32LE(40)).toBe(30);
    expect(out.audio.readUInt32LE(4)).toBe(36 + 30);
  });

  it("refuses mixed formats rather than producing a file nothing can play", () => {
    expect(() =>
      stitch([
        { format: "mp3", audio: Buffer.from("a") },
        { format: "wav", audio: wav(1) },
      ]),
    ).toThrow(/Mixed/);
  });
});

describe("the voice recording service", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tugboat-voice-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const config = () =>
    ({ voiceAudioDir: dir, publicApiUrl: "http://localhost:4000" }) as unknown as AppConfigService;

  it("renders nothing when no synthesiser is configured", async () => {
    const service = new VoiceAudioService(config(), null);
    expect(service.enabled).toBe(false);
    await expect(service.render("CA1", TURNS, "hi-IN")).resolves.toBeNull();
  });

  it("speaks each real turn in its speaker's voice, skips stage directions, and returns the media URL", async () => {
    const spoken: { text: string; speaker: string; language: string }[] = [];
    const synthesizer: TtsSynthesizer = {
      provider: "fake",
      synthesize: async (text, speaker, language) => {
        spoken.push({ text, speaker, language });
        return { format: "mp3", audio: Buffer.from(`<${speaker}>`) };
      },
    };

    const service = new VoiceAudioService(config(), synthesizer);
    const url = await service.render("CA1a2b3c", TURNS, "hi-IN");

    expect(url).toBe("http://localhost:4000/media/voice/CA1a2b3c.mp3");
    expect(spoken.map((turn) => turn.speaker)).toEqual(["BOA", "CUSTOMER"]);
    expect(spoken.every((turn) => turn.language === "hi-IN")).toBe(true);
    expect(readFileSync(join(dir, "CA1a2b3c.mp3")).toString()).toBe("<BOA><CUSTOMER>");
  });

  it("returns null when the synthesiser fails — a call with no recording is still a call", async () => {
    const synthesizer: TtsSynthesizer = {
      provider: "broken",
      synthesize: async () => {
        throw new Error("endpoint moved");
      },
    };

    const service = new VoiceAudioService(config(), synthesizer);
    await expect(service.render("CA2", TURNS, "en-IN")).resolves.toBeNull();
  });

  it("never lets a call id become a path", () => {
    expect(safeName("../../.env")).toBe("_______env");
    expect(safeName("CA1a2b3c")).toBe("CA1a2b3c");
    expect(safeName("../x")).not.toContain("/");
  });
});
