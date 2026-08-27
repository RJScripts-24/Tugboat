import type { CaseEvent, EventKind } from "@prisma/client";

import { istClock, toActivityEntry } from "./case-activity";

function event(overrides: Partial<CaseEvent> = {}): CaseEvent {
  return {
    id: 77,
    caseId: 1042,
    seq: 3,
    kind: "DIAGNOSED",
    title: "Diagnosed",
    summary: "BANK_GATEWAY_DEGRADED · confidence 0.93 · rules-table",
    badgeLabel: null,
    badgeTone: null,
    body: null,
    occurredAt: new Date("2026-08-26T09:02:19.000Z"),
    createdAt: new Date("2026-08-26T09:02:19.000Z"),
    ...overrides,
  } as CaseEvent;
}

describe("a case event, as a feed line", () => {
  it("names the case it belongs to", () => {
    const entry = toActivityEntry(event(), 1042);

    expect(entry.caseId).toBe("C-1042");
    expect(entry.title).toBe("Diagnosed C-1042");
    expect(entry.meta).toBe("BANK_GATEWAY_DEGRADED · confidence 0.93 · rules-table");
  });

  it("does not name it twice when the event already did", () => {
    const entry = toActivityEntry(event({ title: "Recovered C-1042" }), 1042);

    expect(entry.title).toBe("Recovered C-1042");
  });

  it("carries the event row's own id, so a replay cannot duplicate a row", () => {
    expect(toActivityEntry(event({ id: 501 }), 1042).id).toBe("ev-501");
  });

  it("stamps IST, because the whole product is written in it", () => {
    // 09:02:19 UTC is 14:32:19 in Kolkata.
    expect(toActivityEntry(event(), 1042).time).toBe("14:32:19");
    expect(istClock(new Date("2026-08-26T18:30:00.000Z"))).toBe("00:00:00");
  });

  it("reads a policy check that blocked something differently from one that passed", () => {
    const allowed = toActivityEntry(event({ kind: "POLICY_CHECK" }), 1042);
    const blocked = toActivityEntry(
      event({ kind: "POLICY_CHECK", badgeLabel: "BLOCKED" }),
      1042,
    );

    expect(allowed.kind).toBe("POLICY");
    expect(blocked.kind).toBe("POLICY_BLOCK");
    expect(blocked.actor).toBe("POLICY");
  });

  it("gives money coming back its own actor", () => {
    expect(toActivityEntry(event({ kind: "RECOVERED" }), 1042).actor).toBe("RECOVERY");
  });

  it("maps every event kind the wire vocabulary declares", () => {
    // A kind with no mapping would be a feed line that silently never appears.
    const kinds: EventKind[] = [
      "DETECTED",
      "DIAGNOSED",
      "PLANNED",
      "POLICY_CHECK",
      "EMAIL_SENT",
      "WHATSAPP_SENT",
      "VOICE_CALL",
      "RETRY_EXECUTED",
      "CUSTOMER_REPLY",
      "PROMISE_RECORDED",
      "ESCALATED",
      "APPROVAL_DECIDED",
      "HALTED",
      "RECOVERED",
    ];

    for (const kind of kinds) {
      const entry = toActivityEntry(event({ kind }), 1042);
      expect(entry.kind).toBeDefined();
      expect(entry.actor).toBeDefined();
    }
  });
});
