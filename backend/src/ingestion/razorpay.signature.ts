import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Razorpay signs each webhook with HMAC-SHA256 over the exact bytes it sent,
 * keyed by the endpoint's secret. Verifying it is what makes the endpoint a
 * webhook rather than a public "create a case" API, since the URL is reachable
 * by anyone who finds it.
 */
export function razorpaySignature(rawBody: Buffer | string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

/**
 * The comparison must be over the RAW bytes, not over re-serialized JSON:
 * `JSON.stringify(JSON.parse(body))` can reorder keys or change number
 * formatting, and any single byte of difference produces a completely different
 * digest. That is the classic reason a correct secret still fails to verify.
 */
export function verifyRazorpaySignature(
  rawBody: Buffer | string,
  header: string | undefined,
  secret: string,
): boolean {
  if (!header) return false;

  const expected = Buffer.from(razorpaySignature(rawBody, secret), "utf8");
  const received = Buffer.from(header.trim(), "utf8");

  // timingSafeEqual throws on a length mismatch, and its own throw would leak
  // that fact by returning faster than a real comparison.
  if (expected.length !== received.length) return false;

  return timingSafeEqual(expected, received);
}
