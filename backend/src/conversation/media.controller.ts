import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import { Controller, Get, Inject, NotFoundException, Param, Res, StreamableFile } from "@nestjs/common";
import type { Response } from "express";

import { FETCH, type Fetch } from "../channels/channel-adapter.interface";
import { VoiceCallsService } from "../channels/voice-calls.service";
import { AppConfigService } from "../config/app-config.service";

/**
 * `GET /media/voice/<callId>.mp3` — the stitched recording.
 *
 * Behind the ordinary session guard: the file names a customer and an amount,
 * so it is no more public than the timeline it belongs to. The browser's
 * `<audio>` element sends the same-site session cookie without being asked,
 * which is why the guard's cookie path (Stage 9) is enough here.
 *
 * The name is validated against one pattern rather than joined into a path:
 * a route that serves `../` is a route that serves `.env`.
 *
 * A real call's recording lives at Twilio behind the account's credentials;
 * when no local file exists the route fetches it with those credentials and
 * streams it, so the browser plays both kinds through one URL (D-144).
 */
const FILE_NAME = /^[A-Za-z0-9_-]{1,80}\.(mp3|wav)$/;

@Controller("media")
export class MediaController {
  constructor(
    private readonly config: AppConfigService,
    private readonly calls: VoiceCallsService,
    @Inject(FETCH) private readonly fetchImpl: Fetch,
  ) {}

  @Get("voice/:file")
  async voice(
    @Param("file") file: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    if (!FILE_NAME.test(file)) throw new NotFoundException({ error: "No such recording." });

    const path = resolve(this.config.voiceAudioDir, file);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) return this.fromTwilio(file.replace(/\.(mp3|wav)$/, ""), response);

    response.setHeader("Content-Type", file.endsWith(".wav") ? "audio/wav" : "audio/mpeg");
    response.setHeader("Content-Length", String(info.size));
    response.setHeader("Cache-Control", "private, max-age=3600");

    return new StreamableFile(createReadStream(path));
  }

  private async fromTwilio(callId: string, response: Response): Promise<StreamableFile> {
    const twilio = this.config.twilio;
    const call = await this.calls.get(callId);
    if (!twilio || !call?.recordingUrl) throw new NotFoundException({ error: "No such recording." });

    const auth = Buffer.from(`${twilio.accountSid}:${twilio.authToken}`).toString("base64");
    const upstream = await this.fetchImpl(`${call.recordingUrl}.mp3`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (!upstream.ok) throw new NotFoundException({ error: "The recording is not available yet." });

    const audio = Buffer.from(await upstream.arrayBuffer());
    response.setHeader("Content-Type", "audio/mpeg");
    response.setHeader("Content-Length", String(audio.length));
    response.setHeader("Cache-Control", "private, max-age=3600");
    return new StreamableFile(audio);
  }
}
