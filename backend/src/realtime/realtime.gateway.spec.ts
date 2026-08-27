import { JwtService } from "@nestjs/jwt";

import { DomainEventsService } from "../common/domain-events.service";
import type { AppConfigService } from "../config/app-config.service";
import type { DashboardService } from "../dashboard/dashboard.service";
import { RealtimeGateway } from "./realtime.gateway";

/**
 * The gateway translates and nothing else, so what is worth testing is the
 * translation: which rooms an event reaches, and how many times a socket in two
 * of them hears about it.
 */

type Emit = { rooms: string[]; event: string; payload: unknown };

function harness() {
  const emits: Emit[] = [];

  const server = {
    to(rooms: string | string[]) {
      const list = Array.isArray(rooms) ? rooms : [rooms];
      return {
        emit(event: string, payload: unknown) {
          emits.push({ rooms: list, event, payload });
        },
      };
    },
  };

  const domain = new DomainEventsService();

  const gateway = new RealtimeGateway(
    domain,
    new JwtService({}),
    { jwtSecret: "test-secret" } as AppConfigService,
    { kpis: async () => ({}) } as unknown as DashboardService,
  );

  // The @WebSocketServer() property is assigned by Nest at bootstrap; this is
  // the same assignment, done by hand.
  (gateway as unknown as { server: unknown }).server = server;
  gateway.onModuleInit();

  return { gateway, domain, emits };
}

describe("the realtime gateway", () => {
  it("sends one case update to both rooms in a single emit", () => {
    const { gateway, domain, emits } = harness();

    domain.publish({
      name: "case.updated",
      merchantId: "m-1",
      caseId: "C-1042",
      stage: "waiting",
      kind: "WHATSAPP_SENT",
      recoveredPaise: 0,
      attempts: 2,
    });

    // One emit, two rooms — not two emits. A browser showing C-1042 is in both
    // the dashboard room and the case room, and two calls would deliver two
    // copies of one event to it (B-43).
    expect(emits).toHaveLength(1);
    expect(emits[0].rooms).toEqual(["m:m-1:dashboard", "m:m-1:case:C-1042"]);
    expect(emits[0].event).toBe("case.updated");

    gateway.onModuleDestroy();
  });

  it("scopes every room to the merchant that owns the event", () => {
    const { gateway, domain, emits } = harness();

    domain.publish({
      name: "activity.new",
      merchantId: "merchant_a",
      entry: {
        id: "ev-1",
        kind: "DETECT",
        actor: "BOA",
        caseId: "C-1",
        title: "Payment failed C-1",
        meta: "U69 · timeout",
        time: "14:32:19",
      },
    });

    // The prefix is the whole isolation story: without it, one merchant's feed
    // would land in another merchant's browser the day a second one exists.
    expect(emits[0].rooms).toEqual(["merchant_a"].map((id) => `m:${id}:dashboard`));

    gateway.onModuleDestroy();
  });

  it("routes a run's progress to that run's room and nowhere else", () => {
    const { gateway, domain, emits } = harness();

    domain.publish({
      name: "sim.progress",
      merchantId: "m-1",
      runId: "SIM-0042-P",
      progress: 0.4,
      step: null,
      totals: {
        recoveredPaise: 100,
        recoveredCases: 1,
        contacts: 4,
        escalations: 0,
        stopped: 0,
      },
    });

    expect(emits).toHaveLength(1);
    expect(emits[0].rooms).toEqual(["m:m-1:sim:SIM-0042-P"]);

    gateway.onModuleDestroy();
  });

  it("sends no numbers on a kpi nudge — it schedules a recompute instead", () => {
    const { gateway, domain, emits } = harness();

    domain.publish({ name: "kpi.updated", merchantId: "m-1" });

    // The figures are an aggregate over the whole case table, and no publisher
    // should run six aggregate queries inside the transaction it is committing
    // (D-102). Nothing goes out until the coalescing window closes.
    expect(emits).toHaveLength(0);

    gateway.onModuleDestroy();
  });

  it("stops listening when the module is torn down", () => {
    const { gateway, domain, emits } = harness();

    gateway.onModuleDestroy();
    domain.publish({
      name: "policy.changed",
      merchantId: "m-1",
      version: "v9",
    });

    expect(emits).toHaveLength(0);
  });
});
