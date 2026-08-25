import { Injectable } from "@nestjs/common";

import { VoiceDialogueService } from "../conversation/voice-dialogue.service";
import type { GatePass } from "../policy/gate-pass";
import type {
  ChannelAdapter,
  ChannelSendResult,
  SendRequest,
  VoiceCounterpart,
} from "./channel-adapter.interface";
import { seededUnit, voiceCallId } from "./channel-refs";

/** Per-minute telephony at Indian rates, rounded up to the minute as carriers bill. */
const VOICE_COST_PAISE_PER_MINUTE = 55;

const inr = (paise: number) =>
  new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(paise / 100));

@Injectable()
export class SimulatedVoiceAdapter implements ChannelAdapter {
  readonly channel = "VOICE" as const;
  readonly mode = "simulated" as const;

  constructor(private readonly dialogue: VoiceDialogueService) {}

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

    return {
      channelRef: voiceCallId(pass.caseId, request.attempt),
      mode: this.mode,
      costPaise: Math.ceil(detail.seconds / 60) * VOICE_COST_PAISE_PER_MINUTE,
      detail,
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
