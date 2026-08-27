import { Logger, Module } from "@nestjs/common";

import { MediaController } from "../conversation/media.controller";
import { EdgeTtsSynthesizer, SarvamTtsSynthesizer } from "../conversation/tts-synthesizers";
import { VoiceAudioService, type TtsSynthesizer } from "../conversation/voice-audio.service";
import { VoiceDialogueService } from "../conversation/voice-dialogue.service";
import { AppConfigService } from "../config/app-config.service";
import {
  CHANNEL_ADAPTERS,
  FETCH,
  SIMULATED_CHANNEL_ADAPTERS,
  type ChannelAdapter,
} from "./channel-adapter.interface";
import { PaymentLinkService } from "./payment-links.service";
import { RazorpayClient } from "./razorpay.client";
import { RazorpayRetryAdapter } from "./razorpay-retry.adapter";
import { ResendEmailAdapter } from "./resend-email.adapter";
import { SimulatedEmailAdapter } from "./simulated-email.adapter";
import { SimulatedRetryAdapter } from "./simulated-retry.adapter";
import { SimulatedVoiceAdapter } from "./simulated-voice.adapter";
import { SimulatedWhatsappAdapter } from "./simulated-whatsapp.adapter";
import { TwilioVoiceAdapter } from "./twilio-voice.adapter";
import { TwilioWhatsappAdapter } from "./twilio-whatsapp.adapter";
import { VoiceCallsService } from "./voice-calls.service";

/**
 * Every adapter behind one token, keyed by channel — and, since Stage 10,
 * chosen per channel by configuration.
 *
 * The choice is made here and nowhere else. The Executor resolves an adapter
 * from the map and reads `mode` off the result, so a lane switched to real is
 * a one-line change in the environment and the timeline says so on its own.
 * A lane that says `real` without its key never gets this far: the env
 * schema refuses to boot (D-122).
 *
 * Voice follows the same rule since D-144: `CHANNEL_MODE_VOICE=real` with a
 * Twilio voice number places a real call; what `VOICE_TTS` switches on is Boa's
 * voice, on the line or in the stitched recording.
 *
 * A second token always holds the four simulated adapters: a case that belongs
 * to a batch is worked from it whatever the lanes say (D-140).
 */
const logger = new Logger("Channels");

function pick<T extends ChannelAdapter>(
  mode: "simulated" | "real",
  simulated: T,
  real: ChannelAdapter,
): ChannelAdapter {
  const chosen = mode === "real" ? real : simulated;
  logger.log(`${chosen.channel} lane: ${chosen.mode}`);
  return chosen;
}

function buildSynthesizer(config: AppConfigService): TtsSynthesizer | null {
  switch (config.voiceTts) {
    case "edge":
      return new EdgeTtsSynthesizer();
    case "sarvam":
      return new SarvamTtsSynthesizer(config.sarvamApiKey ?? "");
    default:
      return null;
  }
}

@Module({
  controllers: [MediaController],
  providers: [
    VoiceDialogueService,
    { provide: FETCH, useValue: fetch },
    {
      provide: RazorpayClient,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        config.channelModes.razorpay === "real" && config.razorpayKeys
          ? new RazorpayClient(config.razorpayKeys)
          : null,
    },
    PaymentLinkService,
    {
      provide: VoiceAudioService,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => {
        const synthesizer = buildSynthesizer(config);
        logger.log(`VOICE recording: ${synthesizer?.provider ?? "off"}`);
        return new VoiceAudioService(config, synthesizer);
      },
    },
    SimulatedRetryAdapter,
    SimulatedWhatsappAdapter,
    SimulatedEmailAdapter,
    SimulatedVoiceAdapter,
    RazorpayRetryAdapter,
    ResendEmailAdapter,
    TwilioWhatsappAdapter,
    VoiceCallsService,
    TwilioVoiceAdapter,
    {
      provide: SIMULATED_CHANNEL_ADAPTERS,
      inject: [SimulatedRetryAdapter, SimulatedWhatsappAdapter, SimulatedEmailAdapter, SimulatedVoiceAdapter],
      useFactory: (...adapters: ChannelAdapter[]) =>
        new Map<string, ChannelAdapter>(adapters.map((adapter) => [adapter.channel, adapter])),
    },
    {
      provide: CHANNEL_ADAPTERS,
      inject: [
        AppConfigService,
        SimulatedRetryAdapter,
        SimulatedWhatsappAdapter,
        SimulatedEmailAdapter,
        SimulatedVoiceAdapter,
        RazorpayRetryAdapter,
        ResendEmailAdapter,
        TwilioWhatsappAdapter,
        TwilioVoiceAdapter,
      ],
      useFactory: (
        config: AppConfigService,
        retry: SimulatedRetryAdapter,
        whatsapp: SimulatedWhatsappAdapter,
        email: SimulatedEmailAdapter,
        voice: SimulatedVoiceAdapter,
        razorpay: RazorpayRetryAdapter,
        resend: ResendEmailAdapter,
        twilio: TwilioWhatsappAdapter,
        twilioVoice: TwilioVoiceAdapter,
      ) => {
        const modes = config.channelModes;
        const adapters: ChannelAdapter[] = [
          pick(modes.razorpay, retry, razorpay),
          pick(modes.whatsapp, whatsapp, twilio),
          pick(modes.email, email, resend),
          pick(modes.voice, voice, twilioVoice),
        ];
        return new Map<string, ChannelAdapter>(adapters.map((adapter) => [adapter.channel, adapter]));
      },
    },
  ],
  exports: [
    CHANNEL_ADAPTERS,
    SIMULATED_CHANNEL_ADAPTERS,
    VoiceDialogueService,
    VoiceAudioService,
    VoiceCallsService,
    PaymentLinkService,
  ],
})
export class ChannelsModule {}
