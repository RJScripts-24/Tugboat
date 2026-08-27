import { testPass } from "../../test/gate-pass.fixture";
import type { AppConfigService } from "../config/app-config.service";
import type { SendRequest } from "./channel-adapter.interface";
import { OPT_OUT_LINE, withLink } from "./message-copy";
import type { PaymentLinkService } from "./payment-links.service";
import { RazorpayRetryAdapter } from "./razorpay-retry.adapter";
import { ResendEmailAdapter, RESEND_API } from "./resend-email.adapter";
import { toE164, TwilioWhatsappAdapter, twilioMessagesUrl } from "./twilio-whatsapp.adapter";

type Call = { url: string; init: RequestInit };

function fakeFetch(status: number, body: unknown, calls: Call[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

const REAL_LINK = "https://rzp.io/l/C-1042-real";

const links = (created = true) =>
  ({
    linkFor: async () => ({ url: REAL_LINK, providerId: "plink_real", mode: "real", created }),
  }) as unknown as PaymentLinkService;

const config = {
  resendApiKey: "re_key",
  resendFrom: "Boa <onboarding@resend.dev>",
  twilio: { accountSid: "AC1", authToken: "tok", whatsappFrom: "whatsapp:+14155238886" },
} as unknown as AppConfigService;

function request(overrides: Partial<SendRequest> = {}): SendRequest {
  return {
    caseId: 1042,
    attempt: 1,
    to: "priya@example.test",
    copy: {
      caseId: 1042,
      type: "PAYMENT_FAILED",
      rootCause: "INSUFFICIENT_FUNDS",
      amountPaise: 480_000,
      customerName: "Priya Sharma",
      merchantName: "Demo Merchant",
      hinglish: false,
      attempt: 1,
    },
    ...overrides,
  };
}

describe("the Resend email adapter", () => {
  it("sends the copy with the case's real link, bearer-authenticated, and returns Resend's id", async () => {
    const calls: Call[] = [];
    const adapter = new ResendEmailAdapter(config, links(), fakeFetch(200, { id: "re_abc" }, calls));

    const result = await adapter.send(testPass({ channel: "EMAIL" }), request());

    expect(result.mode).toBe("real");
    expect(result.channelRef).toBe("re_abc");
    expect(result.detail).toMatchObject({ kind: "message", channel: "EMAIL", link: REAL_LINK });

    expect(calls[0].url).toBe(RESEND_API);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer re_key");

    const sent = JSON.parse(String(calls[0].init.body)) as { to: string[]; text: string; from: string };
    expect(sent.to).toEqual(["priya@example.test"]);
    expect(sent.from).toBe("Boa <onboarding@resend.dev>");
    // The email copy keeps its link and its opt-out out of the prose (the
    // timeline shows both as fields); a real email has to carry them.
    const lines = sent.text.split("\n\n");
    expect(lines).toContain(`Pay securely here: ${REAL_LINK}`);
    expect(lines[lines.length - 1]).toBe(OPT_OUT_LINE);
    expect(lines.indexOf(`Pay securely here: ${REAL_LINK}`)).toBeLessThan(
      lines.findIndex((line) => line.startsWith("— Boa")),
    );
    expect(sent.text).not.toMatch(/rzp\.io\/l\/tug-/);
  });

  it("sends an approved draft as the approver left it, with only the link substituted", async () => {
    const calls: Call[] = [];
    const adapter = new ResendEmailAdapter(config, links(), fakeFetch(200, { id: "re_2" }, calls));

    const approved = {
      subject: "Approved subject",
      lines: ["Hi Priya, approver's own words.", "Pay here: rzp.io/l/tug-0a1b2c", OPT_OUT_LINE],
    };
    await adapter.send(testPass({ channel: "EMAIL" }), request({ approved }));

    const sent = JSON.parse(String(calls[0].init.body)) as { subject: string; text: string };
    expect(sent.subject).toBe("Approved subject");
    expect(sent.text).toBe(
      ["Hi Priya, approver's own words.", `Pay here: ${REAL_LINK}`, OPT_OUT_LINE].join("\n\n"),
    );
  });

  it("throws on a provider refusal, so the executor records a failed action rather than a sent one", async () => {
    const adapter = new ResendEmailAdapter(config, links(), fakeFetch(422, { message: "invalid to" }, []));

    await expect(adapter.send(testPass({ channel: "EMAIL" }), request())).rejects.toThrow(/Resend 422/);
  });

  it("refuses a customer with no email rather than inventing one", async () => {
    const adapter = new ResendEmailAdapter(config, links(), fakeFetch(200, { id: "x" }, []));

    await expect(adapter.send(testPass({ channel: "EMAIL" }), request({ to: "" }))).rejects.toThrow(
      /No email address/,
    );
  });
});

describe("the Twilio WhatsApp adapter", () => {
  it("posts a form-encoded sandbox message with basic auth and returns the SID", async () => {
    const calls: Call[] = [];
    const adapter = new TwilioWhatsappAdapter(
      config,
      links(),
      fakeFetch(201, { sid: "SM123", status: "queued" }, calls),
    );

    const result = await adapter.send(
      testPass({ channel: "WHATSAPP" }),
      request({ to: "9876543210" }),
    );

    expect(result).toMatchObject({ channelRef: "SM123", mode: "real" });
    expect(result.detail).toMatchObject({ kind: "message", channel: "WHATSAPP", status: "queued · Twilio sandbox" });

    expect(calls[0].url).toBe(twilioMessagesUrl("AC1"));
    const form = new URLSearchParams(String(calls[0].init.body));
    expect(form.get("From")).toBe("whatsapp:+14155238886");
    expect(form.get("To")).toBe("whatsapp:+919876543210");
    expect(form.get("Body")).toContain(REAL_LINK);
    expect(form.get("Body")).toContain(OPT_OUT_LINE);
  });

  it("normalises Indian numbers to E.164 and refuses what it cannot", () => {
    expect(toE164("9876543210")).toBe("+919876543210");
    expect(toE164("919876543210")).toBe("+919876543210");
    expect(toE164("+91 98765 43210")).toBe("+919876543210");
    expect(() => toE164("12345")).toThrow(/E\.164/);
  });
});

describe("the Razorpay retry adapter", () => {
  it("issues the case's link and reports awaiting capture, never a decline", async () => {
    const adapter = new RazorpayRetryAdapter(links(true));

    const result = await adapter.send(testPass({ channel: "RETRY" }), request());

    expect(result.mode).toBe("real");
    expect(result.channelRef).toBe("plink_real");
    expect(result.costPaise).toBe(0);
    expect(result.detail).toMatchObject({
      kind: "retry",
      captured: false,
      failureReason: null,
      link: REAL_LINK,
    });
    expect((result.detail as { awaiting?: string }).awaiting).toMatch(/Payment link issued/);
  });

  it("says a mandate is re-presented on Razorpay's schedule rather than pretending to charge it", async () => {
    const adapter = new RazorpayRetryAdapter(links(false));

    const result = await adapter.send(
      testPass({ channel: "RETRY" }),
      request({ copy: { ...request().copy, type: "MANDATE_FAILED" } }),
    );

    expect((result.detail as { awaiting?: string }).awaiting).toMatch(/subscription\.charged/);
  });
});

describe("link substitution", () => {
  it("replaces only the derived link and leaves every other word alone", () => {
    expect(withLink(["Pay: rzp.io/l/tug-abc123 today", "no link here"], "https://x/y")).toEqual([
      "Pay: https://x/y today",
      "no link here",
    ]);
  });
});
