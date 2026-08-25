import { razorpaySignature, verifyRazorpaySignature } from "./razorpay.signature";

const SECRET = "whsec_tugboat_test";
const BODY = JSON.stringify({ event: "payment.failed", payload: { payment: { entity: {} } } });

describe("razorpay signature", () => {
  it("accepts a signature computed with the same secret", () => {
    const signature = razorpaySignature(BODY, SECRET);
    expect(verifyRazorpaySignature(BODY, signature, SECRET)).toBe(true);
  });

  it("rejects a signature computed with a different secret", () => {
    const signature = razorpaySignature(BODY, "whsec_wrong");
    expect(verifyRazorpaySignature(BODY, signature, SECRET)).toBe(false);
  });

  it("rejects when a single byte of the body changed", () => {
    const signature = razorpaySignature(BODY, SECRET);
    expect(verifyRazorpaySignature(`${BODY} `, signature, SECRET)).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(verifyRazorpaySignature(BODY, undefined, SECRET)).toBe(false);
    expect(verifyRazorpaySignature(BODY, "", SECRET)).toBe(false);
  });

  it("rejects a truncated signature without throwing on the length mismatch", () => {
    const signature = razorpaySignature(BODY, SECRET);
    expect(() => verifyRazorpaySignature(BODY, signature.slice(0, 10), SECRET)).not.toThrow();
    expect(verifyRazorpaySignature(BODY, signature.slice(0, 10), SECRET)).toBe(false);
  });

  it("verifies over raw bytes, so re-serialized JSON does not match", () => {
    // The same object, different byte order: what a body-parser round trip can produce.
    const reordered = JSON.stringify({
      payload: { payment: { entity: {} } },
      event: "payment.failed",
    });
    const signature = razorpaySignature(BODY, SECRET);

    expect(reordered).not.toBe(BODY);
    expect(verifyRazorpaySignature(reordered, signature, SECRET)).toBe(false);
  });

  it("works on a Buffer, which is what Express hands us", () => {
    const buffer = Buffer.from(BODY, "utf8");
    expect(verifyRazorpaySignature(buffer, razorpaySignature(buffer, SECRET), SECRET)).toBe(true);
  });
});
