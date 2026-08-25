import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type { Env } from "./env.validation";

/**
 * Typed accessor over the validated environment.
 *
 * `ConfigService.get` returns `string | undefined` by default; every value read
 * through here is the Zod-parsed type instead (PORT is a number, not "4000"),
 * and a missing key throws at read rather than surfacing as undefined deep in a
 * handler.
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService) {}

  private read<K extends keyof Env>(key: K): Env[K] {
    return this.config.getOrThrow<Env[K]>(key as string);
  }

  get nodeEnv(): Env["NODE_ENV"] {
    return this.read("NODE_ENV");
  }

  get port(): number {
    return this.read("PORT");
  }

  get databaseUrl(): string {
    return this.read("DATABASE_URL");
  }

  /** Falls back to the pooled URL on a Postgres with no separate direct endpoint. */
  get directUrl(): string {
    return this.config.get<string>("DIRECT_URL") ?? this.databaseUrl;
  }

  /** Absent until a Redis TCP URL is configured; the queue module (Stage 5) requires it. */
  get redisUrl(): string | undefined {
    return this.config.get<string>("REDIS_URL");
  }

  get jwtSecret(): string {
    return this.read("JWT_SECRET");
  }

  get frontendOrigin(): string {
    return this.read("FRONTEND_ORIGIN");
  }

  /** Absent until Stage 10; the webhook route fails closed without it. */
  get razorpayWebhookSecret(): string | undefined {
    return this.config.get<string>("RAZORPAY_WEBHOOK_SECRET");
  }

  get llmMode(): Env["LLM_MODE"] {
    return this.read("LLM_MODE");
  }

  get geminiApiKey(): string | undefined {
    return this.config.get<string>("GEMINI_API_KEY");
  }

  get groqApiKey(): string | undefined {
    return this.config.get<string>("GROQ_API_KEY");
  }

  get geminiModel(): string {
    return this.read("GEMINI_MODEL");
  }

  get groqModel(): string {
    return this.read("GROQ_MODEL");
  }

  get channelModes(): Record<"email" | "whatsapp" | "voice" | "razorpay", "simulated" | "real"> {
    return {
      email: this.read("CHANNEL_MODE_EMAIL"),
      whatsapp: this.read("CHANNEL_MODE_WHATSAPP"),
      voice: this.read("CHANNEL_MODE_VOICE"),
      razorpay: this.read("CHANNEL_MODE_RAZORPAY"),
    };
  }

  get isProduction(): boolean {
    return this.nodeEnv === "production";
  }

  get isTest(): boolean {
    return this.nodeEnv === "test";
  }
}
