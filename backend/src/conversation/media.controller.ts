import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import { Controller, Get, NotFoundException, Param, Res, StreamableFile } from "@nestjs/common";
import type { Response } from "express";

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
 */
const FILE_NAME = /^[A-Za-z0-9_-]{1,80}\.(mp3|wav)$/;

@Controller("media")
export class MediaController {
  constructor(private readonly config: AppConfigService) {}

  @Get("voice/:file")
  async voice(
    @Param("file") file: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    if (!FILE_NAME.test(file)) throw new NotFoundException({ error: "No such recording." });

    const path = resolve(this.config.voiceAudioDir, file);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) throw new NotFoundException({ error: "No such recording." });

    response.setHeader("Content-Type", file.endsWith(".wav") ? "audio/wav" : "audio/mpeg");
    response.setHeader("Content-Length", String(info.size));
    response.setHeader("Cache-Control", "private, max-age=3600");

    return new StreamableFile(createReadStream(path));
  }
}
