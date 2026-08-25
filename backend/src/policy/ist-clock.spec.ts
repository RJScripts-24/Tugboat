import {
  alignToPayday,
  formatClock,
  fromIst,
  isQuiet,
  istMinuteOfDay,
  istParts,
  nextPayday,
  nextWindowOpen,
  quietSpanMinutes,
} from "./ist-clock";

const QUIET_START = 21 * 60;
const QUIET_END = 9 * 60;

describe("IST conversion", () => {
  it("reads the wall clock five and a half hours ahead of UTC", () => {
    expect(istMinuteOfDay(new Date("2026-08-24T09:00:00.000Z"))).toBe(14 * 60 + 30);
    expect(istMinuteOfDay(new Date("2026-08-24T00:00:00.000Z"))).toBe(5 * 60 + 30);
  });

  it("rolls the date over at IST midnight, not UTC midnight", () => {
    // 23:00 IST on the 24th is still 17:30 UTC on the 24th...
    expect(istParts(new Date("2026-08-24T17:30:00.000Z"))).toMatchObject({ day: 24, minutes: 23 * 60 });
    // ...but 00:30 IST on the 25th is 19:00 UTC on the 24th.
    expect(istParts(new Date("2026-08-24T19:00:00.000Z"))).toMatchObject({ day: 25, minutes: 30 });
  });

  it("round-trips a wall-clock time", () => {
    const at = fromIst(2026, 7, 24, 21 * 60);
    expect(at.toISOString()).toBe("2026-08-24T15:30:00.000Z");
    expect(istMinuteOfDay(at)).toBe(21 * 60);
  });

  it("is unaffected by the server's own timezone, because India has no DST", () => {
    // January and July give the same offset; a DST-observing zone would not.
    expect(istMinuteOfDay(new Date("2026-01-15T09:00:00.000Z"))).toBe(
      istMinuteOfDay(new Date("2026-07-15T09:00:00.000Z")),
    );
  });
});

describe("the quiet window, which wraps midnight", () => {
  it("measures the blocked span across midnight", () => {
    expect(quietSpanMinutes(QUIET_START, QUIET_END)).toBe(12 * 60);
  });

  it("treats an empty window as quiet hours switched off", () => {
    expect(quietSpanMinutes(600, 600)).toBe(0);
    expect(isQuiet(600, 600, 600)).toBe(false);
  });

  it.each([
    [20 * 60 + 59, false],
    [21 * 60, true],
    [23 * 60 + 30, true],
    [2 * 60, true],
    [8 * 60 + 59, true],
    [9 * 60, false],
    [14 * 60 + 30, false],
  ])("minute %i inside the window: %s", (minute, expected) => {
    expect(isQuiet(minute, QUIET_START, QUIET_END)).toBe(expected);
  });

  it("opens the window at 09:00 IST the same night", () => {
    const at = new Date("2026-08-24T17:00:00.000Z"); // 22:30 IST
    const open = nextWindowOpen(at, QUIET_END);

    expect(istMinuteOfDay(open)).toBe(QUIET_END);
    expect(open.toISOString()).toBe("2026-08-25T03:30:00.000Z");
  });

  it("opens the window later the same morning for an early-hours send", () => {
    const at = new Date("2026-08-24T21:00:00.000Z"); // 02:30 IST on the 25th
    expect(nextWindowOpen(at, QUIET_END).toISOString()).toBe("2026-08-25T03:30:00.000Z");
  });

  it("renders minutes as a clock, the only place the number becomes a string", () => {
    expect(formatClock(QUIET_START)).toBe("21:00");
    expect(formatClock(QUIET_END)).toBe("09:00");
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(23 * 60 + 5)).toBe("23:05");
  });
});

describe("payday alignment", () => {
  it("finds the next 10:00 IST on the first of a month", () => {
    expect(nextPayday(new Date("2026-08-24T09:00:00.000Z")).toISOString()).toBe(
      "2026-09-01T04:30:00.000Z",
    );
  });

  it("counts today when the first has not yet reached 10:00 IST", () => {
    expect(nextPayday(new Date("2026-09-01T00:00:00.000Z")).toISOString()).toBe(
      "2026-09-01T04:30:00.000Z",
    );
  });

  it("crosses the year boundary", () => {
    expect(nextPayday(new Date("2026-12-15T00:00:00.000Z")).toISOString()).toBe(
      "2027-01-01T04:30:00.000Z",
    );
  });

  it("waits for a payday within reach", () => {
    const candidate = new Date("2026-08-30T09:00:00.000Z");
    expect(alignToPayday(candidate).toISOString()).toBe("2026-09-01T04:30:00.000Z");
  });

  it("does not wait weeks for one — the delay would cost more than it recovers", () => {
    const candidate = new Date("2026-08-06T09:00:00.000Z");
    expect(alignToPayday(candidate)).toBe(candidate);
  });
});
