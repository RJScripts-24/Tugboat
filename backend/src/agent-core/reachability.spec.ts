import { unreachableChannels } from "./reachability";

describe("unreachableChannels", () => {
  it("closes the phone channels for a customer with no phone", () => {
    expect(unreachableChannels({ phone: null, email: "a@example.invalid" })).toEqual([
      "WHATSAPP",
      "VOICE",
    ]);
  });

  it("closes email for a customer with no inbox", () => {
    expect(unreachableChannels({ phone: "+919800000001", email: null })).toEqual(["EMAIL"]);
  });

  it("treats a blank contact as a missing one", () => {
    expect(unreachableChannels({ phone: "   ", email: "" })).toEqual(["WHATSAPP", "VOICE", "EMAIL"]);
  });

  it("closes nothing for a fully reachable customer, and never the retry", () => {
    expect(unreachableChannels({ phone: "+919800000001", email: "a@example.invalid" })).toEqual([]);
  });
});
