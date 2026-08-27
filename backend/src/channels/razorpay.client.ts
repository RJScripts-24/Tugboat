/**
 * The Razorpay REST calls this product makes, and nothing else.
 *
 * A hand-written client over `fetch` rather than the `razorpay` npm SDK: the
 * agent needs exactly one write (create a payment link) and the SDK brings a
 * hundred, each a surface a panelist can ask about. Test mode is enforced at
 * construction — a live key is refused, not warned about — because this build
 * has no business moving real money (build prompt §8).
 */

export type RazorpayKeys = { keyId: string; keySecret: string };

export type PaymentLinkRequest = {
  amountPaise: number;
  currency: string;
  /** Unique per case; Razorpay rejects a second link with the same reference. */
  referenceId: string;
  description: string;
  customer: { name: string; email?: string; contact?: string };
  notes: Record<string, string>;
  /** Where the customer lands after paying, if anywhere. */
  callbackUrl?: string;
  /** Unix seconds. */
  expireBy?: number;
};

export type RazorpayPaymentLink = {
  id: string;
  short_url: string;
  status: string;
  reference_id?: string;
  amount?: number;
};

export class RazorpayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RazorpayError";
  }
}

export const RAZORPAY_API = "https://api.razorpay.com/v1";

export class RazorpayClient {
  constructor(
    private readonly keys: RazorpayKeys,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl: string = RAZORPAY_API,
  ) {
    if (!keys.keyId.startsWith("rzp_test_")) {
      throw new Error(
        "RAZORPAY_KEY_ID must be a TEST-mode key (rzp_test_…). This build refuses live keys.",
      );
    }
  }

  async createPaymentLink(input: PaymentLinkRequest): Promise<RazorpayPaymentLink> {
    return this.post<RazorpayPaymentLink>("/payment_links", {
      amount: input.amountPaise,
      currency: input.currency,
      accept_partial: false,
      reference_id: input.referenceId,
      description: input.description,
      customer: {
        name: input.customer.name,
        ...(input.customer.email ? { email: input.customer.email } : {}),
        ...(input.customer.contact ? { contact: input.customer.contact } : {}),
      },
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: input.notes,
      ...(input.callbackUrl ? { callback_url: input.callbackUrl, callback_method: "get" } : {}),
      ...(input.expireBy ? { expire_by: input.expireBy } : {}),
    });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const auth = Buffer.from(`${this.keys.keyId}:${this.keys.keySecret}`).toString("base64");

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new RazorpayError(response.status, `Razorpay ${response.status}: ${describe(text)}`);
    }

    return JSON.parse(text) as T;
  }
}

/** Razorpay's error envelope is `{ error: { code, description } }`; anything else is quoted as-is. */
function describe(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { code?: string; description?: string } };
    if (parsed.error?.description) {
      return `${parsed.error.code ?? "error"} — ${parsed.error.description}`;
    }
  } catch {
    // Not JSON.
  }
  return text.slice(0, 200);
}
