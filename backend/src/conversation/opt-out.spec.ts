import { OPT_OUT_KEYWORDS, matchOptOut } from "./opt-out";

describe("the opt-out keyword matcher", () => {
  it.each(OPT_OUT_KEYWORDS)("matches %s on its own", (keyword) => {
    expect(matchOptOut(keyword)).toBe(keyword);
  });

  it.each([
    ["stop"],
    ["Stop"],
    ["STOP."],
    ["stop!"],
    ["  STOP  "],
    ["STOP karo ye messages"],
    ["unsubscribe me from this"],
    ["OPT OUT please"],
    ["band karo yaar"],
    ["बंद करो"],
    ["मत भेजो please"],
    ["no thanks\nSTOP"],
  ])("closes the customer on %s", (text) => {
    expect(matchOptOut(text)).not.toBeNull();
  });

  it.each([
    ["I will pay at the bus stop"],
    ["Non-stop messages from you people"],
    ["stopped my card yesterday"],
    ["Paid already, thanks"],
    ["Kal kar dunga"],
    [""],
  ])("leaves %s alone", (text) => {
    expect(matchOptOut(text)).toBeNull();
  });

  it("does not close a customer who quotes our own opt-out line back at us", () => {
    // Every message this agent sends ends with exactly this sentence. A
    // customer replying with the whole thing quoted is not opting out, and a
    // matcher that scanned anywhere in the text would close them.
    expect(matchOptOut("Reply STOP if you'd rather not hear from us.")).toBeNull();
  });

  it("leaves the softer phrasings to the classifier, on purpose", () => {
    // These are real opt-outs and this layer misses them deliberately: matching
    // "stop" anywhere would also catch "bus stop". The classifier reads them as
    // opt-out, and its verdict closes the account exactly as a keyword does —
    // two layers, of which only this one has to work with no network.
    expect(matchOptOut("please stop messaging me")).toBeNull();
    expect(matchOptOut("ok, unsubscribe me")).toBeNull();
  });

  it("needs no model, which is the point", () => {
    // Opt-out is the one rule with no switch (D-43), so the deterministic layer
    // is a pure function over a fixed list and nothing else.
    expect(matchOptOut("STOP")).toBe("STOP");
  });
});
