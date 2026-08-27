import { DomainEventsService } from "./domain-events.service";
import type { DomainEvent } from "./domain-event";

/**
 * The property this bus exists for: nothing is announced until it is true.
 *
 * Every one of these is a failure that would have reached a browser. The
 * ordinary emitter behaviour is asserted too, because "buffers correctly" is
 * worth nothing if the flush never happens.
 */

function kpiEvent(merchantId = "m-1"): DomainEvent {
  return { name: "kpi.updated", merchantId };
}

describe("DomainEventsService", () => {
  let bus: DomainEventsService;
  let seen: DomainEvent[];

  beforeEach(() => {
    bus = new DomainEventsService();
    seen = [];
    bus.on("kpi.updated", (event) => seen.push(event));
  });

  it("delivers immediately outside a transaction", () => {
    bus.publish(kpiEvent());

    expect(seen).toHaveLength(1);
  });

  it("holds a publish until the transaction it is inside resolves", async () => {
    const order: string[] = [];
    bus.on("kpi.updated", () => order.push("delivered"));

    await bus.collect(async () => {
      bus.publish(kpiEvent());
      order.push("still inside");
      expect(seen).toHaveLength(0);
    });

    expect(order).toEqual(["still inside", "delivered"]);
    expect(seen).toHaveLength(1);
  });

  it("drops everything a failed transaction published", async () => {
    await expect(
      bus.collect(async () => {
        bus.publish(kpiEvent());
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");

    // The whole point. A case that moved to `recovered` and then rolled back
    // must not leave a browser showing money that never arrived.
    expect(seen).toHaveLength(0);
  });

  it("lets the outermost transaction own the flush", async () => {
    await bus.collect(async () => {
      await bus.collect(async () => {
        bus.publish(kpiEvent());
      });

      // The inner call committed nothing on its own: the database has not
      // committed either, so neither should the announcement.
      expect(seen).toHaveLength(0);
    });

    expect(seen).toHaveLength(1);
  });

  it("keeps two concurrent transactions from flushing each other's events", async () => {
    const delivered: string[] = [];
    bus.on("kpi.updated", (event) => delivered.push(event.merchantId));

    const failing = bus
      .collect(async () => {
        bus.publish(kpiEvent("doomed"));
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error("rolled back");
      })
      .catch(() => undefined);

    const succeeding = bus.collect(async () => {
      bus.publish(kpiEvent("committed"));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    await Promise.all([failing, succeeding]);

    // A shared buffer would have flushed the doomed merchant's event out of the
    // other transaction's commit. The async-context frame is what stops it.
    expect(delivered).toEqual(["committed"]);
  });

  it("does not let a broken listener fail the write that published the event", () => {
    bus.on("kpi.updated", () => {
      throw new Error("a socket that has gone away");
    });

    expect(() => bus.publish(kpiEvent())).not.toThrow();
  });

  it("stops delivering after unsubscribe", () => {
    const off = bus.on("policy.changed", () => seen.push(kpiEvent()));
    off();

    bus.publish({ name: "policy.changed", merchantId: "m-1", version: "v9" });

    expect(seen).toHaveLength(0);
  });
});
