import { twilioSignature, twilioSignatureValid } from "./twilio-signature";

describe("twilioSignature — the webhook's own proof of origin (D-144)", () => {
  // The worked example from Twilio's security documentation.
  const token = "12345";
  const url = "https://mycompany.com/myapp.php?foo=1&bar=2";
  const params = {
    CallSid: "CA1234567890ABCDE",
    Caller: "+12349013030",
    Digits: "1234",
    From: "+12349013030",
    To: "+18005551212",
  };

  it("reproduces Twilio's documented signature", () => {
    expect(twilioSignature(token, url, params)).toBe("0/KCTR6DLpKmkAf8muzZqo1nDgQ=");
  });

  it("accepts the genuine signature and nothing else", () => {
    expect(twilioSignatureValid(token, url, params, "0/KCTR6DLpKmkAf8muzZqo1nDgQ=")).toBe(true);
    expect(twilioSignatureValid(token, url, params, "0/KCTR6DLpKmkAf8muzZqo1nDgX=")).toBe(false);
    expect(twilioSignatureValid(token, url, { ...params, Digits: "9999" }, "0/KCTR6DLpKmkAf8muzZqo1nDgQ=")).toBe(false);
    expect(twilioSignatureValid(token, url, params, undefined)).toBe(false);
  });
});
