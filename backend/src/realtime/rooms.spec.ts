import { DEFAULT_CONCERNS, isSubscribable, roomFor } from "./rooms";

/**
 * A room name is an authorisation decision, so it is tested like one.
 */
describe("realtime rooms", () => {
  it("scopes every room to the merchant it belongs to", () => {
    expect(roomFor("merchant_a", "dashboard")).toBe("m:merchant_a:dashboard");
    expect(roomFor("merchant_b", "dashboard")).toBe("m:merchant_b:dashboard");
    expect(roomFor("merchant_a", "dashboard")).not.toBe(roomFor("merchant_b", "dashboard"));
  });

  it("accepts the four concerns the gateway publishes to", () => {
    expect(isSubscribable("dashboard")).toBe(true);
    expect(isSubscribable("approvals")).toBe(true);
    expect(isSubscribable("case:C-1042")).toBe(true);
    expect(isSubscribable("sim:SIM-0042-P")).toBe(true);
  });

  it("refuses anything that is not one", () => {
    // A client naming a raw room rather than a concern is the leak this guards:
    // without it, `join` would subscribe any signed-in browser to any string.
    expect(isSubscribable("m:someone-else:dashboard")).toBe(false);
    expect(isSubscribable("case:*")).toBe(false);
    expect(isSubscribable("case:1042")).toBe(false);
    expect(isSubscribable("")).toBe(false);
    expect(isSubscribable("__proto__")).toBe(false);
  });

  it("joins the feed and the badge without being asked", () => {
    // Both are on every page of the shell, so a browser that had to ask for
    // them would show a stale approvals count until it did.
    expect(DEFAULT_CONCERNS).toEqual(["dashboard", "approvals"]);
  });
});
