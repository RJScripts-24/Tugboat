import { validateEnv } from "./env.validation";

const VALID = {
  DATABASE_URL: "postgresql://tugboat:tugboat@localhost:5432/tugboat",
  JWT_SECRET: "x".repeat(32),
};

describe("validateEnv", () => {
  it("coerces PORT to a number and applies defaults", () => {
    const env = validateEnv({ ...VALID, PORT: "4000" });

    expect(env.PORT).toBe(4000);
    expect(env.NODE_ENV).toBe("development");
    expect(env.FRONTEND_ORIGIN).toBe("http://localhost:3000");
    expect(env.LLM_MODE).toBe("fake");
    expect(env.CHANNEL_MODE_EMAIL).toBe("simulated");
  });

  it("rejects a database URL with the wrong protocol", () => {
    expect(() => validateEnv({ ...VALID, DATABASE_URL: "mysql://localhost:3306/tugboat" })).toThrow(
      /DATABASE_URL/,
    );
  });

  it("rejects a URL-shaped string that is not a URL", () => {
    expect(() => validateEnv({ ...VALID, REDIS_URL: "localhost:6379" })).toThrow(/REDIS_URL/);
  });

  it("treats REDIS_URL as optional until BullMQ needs it, but still validates it", () => {
    expect(validateEnv(VALID).REDIS_URL).toBeUndefined();
    expect(validateEnv({ ...VALID, REDIS_URL: "rediss://host:6379" }).REDIS_URL).toBe(
      "rediss://host:6379",
    );
    // An Upstash REST endpoint is HTTP and cannot drive a queue.
    expect(() =>
      validateEnv({ ...VALID, REDIS_URL: "https://just-wren-118017.upstash.io" }),
    ).toThrow(/REDIS_URL/);
  });

  it("treats DIRECT_URL as optional, for a Postgres with no separate endpoint", () => {
    expect(validateEnv(VALID).DIRECT_URL).toBeUndefined();
    expect(() => validateEnv({ ...VALID, DIRECT_URL: "not-a-url" })).toThrow(/DIRECT_URL/);
  });

  it("rejects a signing key short enough to brute-force", () => {
    expect(() => validateEnv({ ...VALID, JWT_SECRET: "too-short" })).toThrow(/JWT_SECRET/);
  });

  it("reads a blank KEY= line as not set, so keys can be listed before they are filled in (B-60)", () => {
    const env = validateEnv({ ...VALID, RESEND_API_KEY: "", RAZORPAY_KEY_ID: "   ", GROQ_API_KEY: "" });

    expect(env.RESEND_API_KEY).toBeUndefined();
    expect(env.RAZORPAY_KEY_ID).toBeUndefined();
    expect(env.GROQ_API_KEY).toBeUndefined();
  });

  it("still refuses a real lane whose key line is blank", () => {
    expect(() => validateEnv({ ...VALID, CHANNEL_MODE_EMAIL: "real", RESEND_API_KEY: "" })).toThrow(
      /RESEND_API_KEY/,
    );
  });

  it("rejects an unknown channel mode rather than silently defaulting", () => {
    expect(() => validateEnv({ ...VALID, CHANNEL_MODE_VOICE: "sort-of-real" })).toThrow(
      /CHANNEL_MODE_VOICE/,
    );
  });

  it("names every offending variable in one message", () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL[\s\S]*JWT_SECRET/);
  });
});

describe("Stage 10 lanes", () => {
  it("refuses a real lane that has no key, naming the lane and the key", () => {
    expect(() => validateEnv({ ...VALID, CHANNEL_MODE_EMAIL: "real" })).toThrow(/CHANNEL_MODE_EMAIL.*RESEND_API_KEY/);
    expect(() => validateEnv({ ...VALID, CHANNEL_MODE_WHATSAPP: "real" })).toThrow(/TWILIO_ACCOUNT_SID/);
    expect(() => validateEnv({ ...VALID, CHANNEL_MODE_RAZORPAY: "real", RAZORPAY_KEY_ID: "rzp_test_x" })).toThrow(
      /RAZORPAY_KEY_SECRET/,
    );
  });

  it("accepts a real lane with its key", () => {
    const env = validateEnv({ ...VALID, CHANNEL_MODE_EMAIL: "real", RESEND_API_KEY: "re_x" });
    expect(env.CHANNEL_MODE_EMAIL).toBe("real");
    expect(env.RESEND_FROM).toContain("onboarding@resend.dev");
  });

  it("never lets telephony claim to be real", () => {
    expect(() => validateEnv({ ...VALID, CHANNEL_MODE_VOICE: "real" })).toThrow(/simulated and labelled/);
  });

  it("wants a key for Sarvam and none for Edge", () => {
    expect(() => validateEnv({ ...VALID, VOICE_TTS: "sarvam" })).toThrow(/SARVAM_API_KEY/);
    expect(validateEnv({ ...VALID, VOICE_TTS: "edge" }).VOICE_TTS).toBe("edge");
    expect(validateEnv(VALID).VOICE_TTS).toBe("off");
    expect(validateEnv(VALID).PUBLIC_API_URL).toBe("http://localhost:4000");
  });
});
