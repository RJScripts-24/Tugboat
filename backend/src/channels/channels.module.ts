import { Module } from "@nestjs/common";

import { VoiceDialogueService } from "../conversation/voice-dialogue.service";
import { CHANNEL_ADAPTERS, type ChannelAdapter } from "./channel-adapter.interface";
import { SimulatedEmailAdapter } from "./simulated-email.adapter";
import { SimulatedRetryAdapter } from "./simulated-retry.adapter";
import { SimulatedVoiceAdapter } from "./simulated-voice.adapter";
import { SimulatedWhatsappAdapter } from "./simulated-whatsapp.adapter";

/**
 * Every adapter behind one token, keyed by channel.
 *
 * The Executor resolves an adapter from this map rather than importing one, so
 * Stage 10 replaces a simulated adapter with a real one by changing this list
 * and nothing above it.
 */
@Module({
  providers: [
    VoiceDialogueService,
    SimulatedRetryAdapter,
    SimulatedWhatsappAdapter,
    SimulatedEmailAdapter,
    SimulatedVoiceAdapter,
    {
      provide: CHANNEL_ADAPTERS,
      inject: [
        SimulatedRetryAdapter,
        SimulatedWhatsappAdapter,
        SimulatedEmailAdapter,
        SimulatedVoiceAdapter,
      ],
      useFactory: (...adapters: ChannelAdapter[]) =>
        new Map<string, ChannelAdapter>(adapters.map((adapter) => [adapter.channel, adapter])),
    },
  ],
  exports: [CHANNEL_ADAPTERS, VoiceDialogueService],
})
export class ChannelsModule {}
