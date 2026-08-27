import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";

import { Injectable, Logger } from "@nestjs/common";

import type { DomainEvent, DomainEventName, DomainEventOf } from "./domain-event";

/**
 * The bus between what happened and who is watching.
 *
 * Two properties, and the second is the whole reason this is not a bare
 * `EventEmitter`.
 *
 * **Nothing is announced until it is true.** Every domain event this project
 * publishes is written inside a database transaction — a case event, its state
 * change and its ledger row land together or not at all (ADR-2). Emitting from
 * inside that transaction would broadcast a case moving to `recovered` and then
 * roll the move back, leaving every open browser showing a recovery that never
 * happened and no event that ever corrects it. So a publish inside a
 * transaction is *buffered*, and the buffer is flushed only when the
 * transaction resolves. If it throws, the buffer is discarded with it.
 *
 * The buffer lives in an async-context frame rather than in a field, for the
 * same reason the clock's offset does: a dozen simulated cases are in flight at
 * once and each one owns its own transaction, so a shared buffer would flush
 * one case's events out of another case's commit.
 *
 * **A slow listener cannot break a write.** Subscribers are called
 * synchronously after the commit and their failures are logged rather than
 * rethrown: a socket that has gone away is not a reason to fail the request
 * that wrote the row.
 */
@Injectable()
export class DomainEventsService {
  private readonly logger = new Logger(DomainEventsService.name);
  private readonly emitter = new EventEmitter();
  private readonly outbox = new AsyncLocalStorage<DomainEvent[]>();

  constructor() {
    // Node prints a warning past ten listeners on one channel, which is a leak
    // heuristic for user code and wrong here: the gateway subscribes once per
    // event name at boot and never unsubscribes.
    this.emitter.setMaxListeners(64);
  }

  /**
   * Announce something — after the transaction that made it true, if there is
   * one.
   */
  publish(event: DomainEvent): void {
    const buffer = this.outbox.getStore();
    if (buffer) {
      buffer.push(event);
      return;
    }

    this.deliver(event);
  }

  /**
   * Runs `work`, holding back everything published inside it until it resolves.
   *
   * Nested calls do nothing: an inner transaction that flushed on its own
   * commit would defeat the outer one, so the outermost frame owns the flush.
   */
  async collect<T>(work: () => Promise<T>): Promise<T> {
    if (this.outbox.getStore()) return work();

    const buffer: DomainEvent[] = [];
    const result = await this.outbox.run(buffer, work);

    for (const event of buffer) this.deliver(event);
    return result;
  }

  /** Subscribe to one event name. Returns the unsubscribe, for tests. */
  on<N extends DomainEventName>(name: N, listener: (event: DomainEventOf<N>) => void): () => void {
    const wrapped = (event: DomainEvent): void => listener(event as DomainEventOf<N>);
    this.emitter.on(name, wrapped);
    return () => {
      this.emitter.off(name, wrapped);
    };
  }

  private deliver(event: DomainEvent): void {
    try {
      this.emitter.emit(event.name, event);
    } catch (error) {
      this.logger.warn(`A ${event.name} listener threw: ${(error as Error).message}`);
    }
  }
}
