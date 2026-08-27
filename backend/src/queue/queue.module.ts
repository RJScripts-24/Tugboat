import { Global, Logger, Module, type OnApplicationShutdown } from "@nestjs/common";
import { Inject } from "@nestjs/common";

import { ClockService } from "../common/clock.service";
import { AppConfigService } from "../config/app-config.service";
import { ACTION_QUEUE, type ActionQueue } from "./action-queue.interface";
import { BullActionQueue } from "./bull-action-queue";
import { InlineActionQueue } from "./inline-action-queue";
import { RoutedActionQueue } from "./routed-action-queue";

/**
 * Redis present means a real queue; absent means the deterministic one.
 *
 * Choosing by configuration rather than by NODE_ENV is deliberate: the batch
 * runner wants the inline queue even in production, because a 200-case
 * simulation cannot wait three real days for a mandate re-presentation.
 */
function buildQueue(config: AppConfigService, clock: ClockService): ActionQueue {
  const logger = new Logger("ActionQueue");

  // The batch's queue reads the agent's clock, so a wait scheduled inside a
  // shifted run is due at a shifted instant (see RoutedActionQueue).
  const batch = new InlineActionQueue(() => clock.nowMs());

  if (!config.redisUrl) {
    logger.warn("REDIS_URL is not set — using the in-memory queue (jobs run only when drained)");
    return new RoutedActionQueue(new InlineActionQueue(), batch, clock);
  }

  logger.log("REDIS_URL is set — scheduling through BullMQ");
  return new RoutedActionQueue(new BullActionQueue(config.redisUrl), batch, clock);
}

@Global()
@Module({
  providers: [
    {
      provide: ACTION_QUEUE,
      inject: [AppConfigService, ClockService],
      useFactory: buildQueue,
    },
  ],
  exports: [ACTION_QUEUE],
})
export class QueueModule implements OnApplicationShutdown {
  constructor(@Inject(ACTION_QUEUE) private readonly queue: ActionQueue) {}

  /** In-flight jobs finish before the process exits; `main.ts` enables the hook. */
  async onApplicationShutdown(): Promise<void> {
    await this.queue.close();
  }
}
