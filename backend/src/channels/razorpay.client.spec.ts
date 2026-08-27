import { RAZORPAY_API, RazorpayClient, RazorpayError } from "./razorpay.client";

type Call = { url: string; init: RequestInit };

function fakeFetch(status: number, body: unknown, calls: Call[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

const KEYS = { keyId: "rzp_test_abc123", keySecret: "s3cret" };

describe("the Razorpay client", () => {
  it("refuses a live key at construction — this build never moves real money", () => {
    expect(() => new RazorpayClient({ keyId: "rzp_live_abc", keySecret: "x" })).toThrow(
      /TEST-mode key/,
    );
  });

  it("creates a payment link with basic auth, the case reference and the notes the webhook reads", async () => {
    const calls: Call[] = [];
    const client = new RazorpayClient(
      KEYS,
      fakeFetch(200, { id: "plink_1", short_url: "https://rzp.io/l/abc", status: "created" }, calls),
    );

    const link = await client.createPaymentLink({
      amountPaise: 480_000,
      currency: "INR",
      referenceId: "C-1042",
      description: "Demo Merchant · payment failed",
      customer: { name: "Priya", email: "p@example.test" },
      notes: { tugboat_case: "C-1042" },
    });

    expect(link).toMatchObject({ id: "plink_1", short_url: "https://rzp.io/l/abc" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${RAZORPAY_API}/payment_links`);

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from("rzp_test_abc123:s3cret").toString("base64")}`,
    );

    const sent = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect(sent).toMatchObject({
      amount: 480_000,
      currency: "INR",
      reference_id: "C-1042",
      notes: { tugboat_case: "C-1042" },
      // Boa does the notifying; Razorpay's own reminders would be a second,
      // unbounded channel outside the gate.
      notify: { sms: false, email: false },
      reminder_enable: false,
    });
  });

  it("surfaces Razorpay's own error description with the status", async () => {
    const client = new RazorpayClient(
      KEYS,
      fakeFetch(400, { error: { code: "BAD_REQUEST_ERROR", description: "reference_id already exists" } }, []),
    );

    await expect(
      client.createPaymentLink({
        amountPaise: 1,
        currency: "INR",
        referenceId: "C-1",
        description: "x",
        customer: { name: "x" },
        notes: {},
      }),
    ).rejects.toThrow(new RazorpayError(400, "Razorpay 400: BAD_REQUEST_ERROR — reference_id already exists"));
  });
});
