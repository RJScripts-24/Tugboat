import { Injectable } from "@nestjs/common";

import { VoiceAudioService } from "../conversation/voice-audio.service";
import { VoiceDialogueService } from "../conversation/voice-dialogue.service";
import type { GatePass } from "../policy/gate-pass";
import type {
  ChannelAdapter,
  ChannelSendResult,
  SendRequest,
  VoiceCounterpart,
} from "./channel-adapter.interface";
import { voiceCostPaise } from "./channel-costs";
import { seededUnit, voiceCallId } from "./channel-refs";

const inr = (paise: number) =>
  new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(paise / 100));

@Injectable()
export class SimulatedVoiceAdapter implements ChannelAdapter {
  readonly channel = "VOICE" as const;
  readonly mode = "simulated" as const;

  constructor(
    private readonly dialogue: VoiceDialogueService,
    private readonly audio: VoiceAudioService,
  ) {}

  async send(pass: GatePass, request: SendRequest): Promise<ChannelSendResult> {
    const detail = await this.dialogue.converse({
      caseId: pass.caseId,
      customerName: request.copy.customerName,
      merchantName: request.copy.merchantName,
      amountLabel: `₹${inr(request.copy.amountPaise)}`,
      hinglish: request.copy.hinglish,
      promiseDateLabel: request.promiseDateLabel ?? "Friday",
      counterpart: request.counterpart ?? defaultCounterpart(pass.caseId),
    });

    const channelRef = voiceCallId(pass.caseId, request.attempt);

    // The recording is the one real thing on this lane (D-126). It is rendered
    // after the call is decided, so a synthesiser that is down changes nothing
    // about the outcome — only whether there is something to play.
    const audioUrl = await this.audio.render(channelRef, detail.transcript, detail.language);

    return {
      channelRef,
      mode: this.mode,
      costPaise: voiceCostPaise(detail.seconds),
      detail: {
        ...detail,
        audioUrl,
        recording: audioUrl ? `Synthesised recording · ${this.audio.provider} · not a phone call` : null,
      },
    };
  }
}

/**
 * How the call goes when nobody has said.
 *
 * Stage 8 personas replace this entirely. Until then the outcome is seeded by
 * case id so a rerun is identical, and the split is deliberately pessimistic —
 * a demo in which every call yields a promise is a demo nobody believes.
 */
function defaultCounterpart(caseId: number): VoiceCounterpart {
  const roll = seededUnit(`${caseId}/voice/outcome`);
  if (roll < 0.34) return "no-answer";
  if (roll < 0.55) return "decline";
  return "promise";
}
