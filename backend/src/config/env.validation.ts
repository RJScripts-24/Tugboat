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

export const envSchema = z.object({
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
