import { z } from "zod";

/**
 * Accepts only a parseable URL whose protocol is one we actually speak.
 * A regex would pass "postgres://" with no host; `new URL` will not.
 */
function urlWithProtocol(protocols: string[], label: string) {
  return z
    .string()
    .min(1)
    .refine(
      (value) => {
        try {
          return protocols.includes(new URL(value).protocol.replace(":", ""));
        } catch {
          return false;
        }
      },
      {
        message: `must be a valid ${label} URL (${protocols
          .map((protocol) => `${protocol}://`)
          .join(" or ")})`,
      },
    );
}

const envObject = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),

  DATABASE_URL: urlWithProtocol(["postgres", "postgresql"], "PostgreSQL"),
  // Neon's pooler cannot hold the advisory locks Prisma Migrate takes. Optional
  // because a plain Postgres has no separate direct endpoint; falls back to
  // DATABASE_URL when absent.
  DIRECT_URL: urlWithProtocol(["postgres", "postgresql"], "PostgreSQL").optional(),
  // Optional until Stage 5 introduces BullMQ. It must be a Redis TCP URL — an
  // HTTP REST endpoint cannot run a queue — and the queue module fails loudly
  // if it is still missing by then.
  REDIS_URL: urlWithProtocol(["redis", "rediss"], "Redis").optional(),

  // 32 chars is the floor for an HS256 signing key that is not trivially brute-forced.
  JWT_SECRET: z.string().min(32, "must be at least 32 characters"),
  FRONTEND_ORIGIN: urlWithProtocol(["http", "https"], "HTTP").default("http://localhost:3000"),

  // Without it the Razorpay webhook route refuses every delivery: an
  // unauthenticated case-creation endpoint is worse than a dead one.
  RAZORPAY_WEBHOOK_SECRET: z.string().min(1).optional(),

  // Every outbound lane defaults to the offline implementation, so a fresh
  // clone with no third-party keys still runs the full agent loop end to end.
  LLM_MODE: z.enum(["fake", "live"]).default("fake"),

  GEMINI_API_KEY: z.string().min(1).optional(),
  GROQ_API_KEY: z.string().min(1).optional(),
  // Model ids move faster than code does; keeping them in config means a
  // deprecation is an env edit rather than a patch.
  GEMINI_MODEL: z.string().min(1).default("gemini-2.0-flash"),
  GROQ_MODEL: z.string().min(1).default("llama-3.3-70b-versatile"),
  CHANNEL_MODE_EMAIL: z.enum(["simulated", "real"]).default("simulated"),
  CHANNEL_MODE_WHATSAPP: z.enum(["simulated", "real"]).default("simulated"),
  CHANNEL_MODE_VOICE: z.enum(["simulated", "real"]).default("simulated"),
  CHANNEL_MODE_RAZORPAY: z.enum(["simulated", "real"]).default("simulated"),

  // Stage 10 — the real providers. Every key is optional on its own; what is
  // not optional is the pairing below: a channel switched to `real` without
  // the key it needs refuses to boot, because an adapter that silently fell
  // back to simulated would put "real message" labels on messages nobody sent.
  RAZORPAY_KEY_ID: z.string().min(1).optional(),
  RAZORPAY_KEY_SECRET: z.string().min(1).optional(),

  RESEND_API_KEY: z.string().min(1).optional(),
  // Resend's onboarding sender works with no domain verified, but only to the
  // address that owns the API key — which is exactly the Stage 10 acceptance
  // test (one real email in the owner's inbox).
  RESEND_FROM: z.string().min(3).default("Boa at Tugboat <onboarding@resend.dev>"),

  TWILIO_ACCOUNT_SID: z.string().min(1).optional(),
  TWILIO_AUTH_TOKEN: z.string().min(1).optional(),
  // The Twilio WhatsApp sandbox number. A recipient must have joined the
  // sandbox ("join <word>") before the first message reaches them.
  TWILIO_WHATSAPP_FROM: z.string().min(1).default("whatsapp:+14155238886"),

  // Telephony stays simulated and labelled in every mode (PRD 7.8); what this
  // switches on is the recording — per-turn TTS stitched into one file the
  // Case Detail player streams. `edge` needs no key.
  VOICE_TTS: z.enum(["off", "edge", "sarvam"]).default("off"),
  SARVAM_API_KEY: z.string().min(1).optional(),
  VOICE_AUDIO_DIR: z.string().min(1).default("var/voice"),

  // Where the browser reaches this API — the base for audio URLs and the
  // callback URL a payment link carries. Behind a tunnel this is the tunnel.
  PUBLIC_API_URL: urlWithProtocol(["http", "https"], "HTTP").default("http://localhost:4000"),
});

/**
 * The cross-field rules. Zod's object schema checks each key alone; these
 * check the combinations that decide whether a "real" lane can actually run.
 */
export const envSchema = envObject.superRefine((env, ctx) => {
  const need = (condition: boolean, path: string, message: string) => {
    if (condition) ctx.addIssue({ code: "custom", path: [path], message });
  };

  need(
    env.CHANNEL_MODE_RAZORPAY === "real" && !(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET),
    "CHANNEL_MODE_RAZORPAY",
    "is 'real' but RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set (test-mode keys from dashboard.razorpay.com)",
  );
  need(
    env.CHANNEL_MODE_EMAIL === "real" && !env.RESEND_API_KEY,
    "CHANNEL_MODE_EMAIL",
    "is 'real' but RESEND_API_KEY is not set (resend.com)",
  );
  need(
    env.CHANNEL_MODE_WHATSAPP === "real" &&
      !(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_WHATSAPP_FROM),
    "CHANNEL_MODE_WHATSAPP",
    "is 'real' but TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are not set (twilio.com console, WhatsApp sandbox)",
  );
  need(
    env.CHANNEL_MODE_VOICE === "real",
    "CHANNEL_MODE_VOICE",
    "cannot be 'real': telephony is simulated and labelled by design (PRD 7.8); set VOICE_TTS=edge for a synthesised recording",
  );
  need(
    env.VOICE_TTS === "sarvam" && !env.SARVAM_API_KEY,
    "VOICE_TTS",
    "is 'sarvam' but SARVAM_API_KEY is not set (sarvam.ai); use VOICE_TTS=edge, which needs no key",
  );
});

export type Env = z.infer<typeof envSchema>;

/**
 * Runs at module init. Throwing here aborts the boot: the process must never
 * reach a request handler holding an environment it has not verified.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");

    throw new Error(
      `Invalid environment configuration:\n${issues}\n\n` +
        `Copy backend/.env.example to backend/.env and fill in the values.`,
    );
  }

  return result.data;
}
