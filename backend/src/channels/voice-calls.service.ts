import { Injectable } from "@nestjs/common";
import type { Prisma, VoiceCall } from "@prisma/client";

import type { LiveDialogueContext } from "../conversation/voice-dialogue.service";
import { PrismaService } from "../prisma/prisma.service";
import type { Turn, VoiceIntent } from "./channel-adapter.interface";

export type VoiceCallStatus = "dialing" | "talking" | "wrapping" | "completed" | "failed";

/**
 * The state of a real call while it is happening.
 *
 * A live call is a conversation spread over several webhooks, seconds apart,
 * each of which knows only the call id Twilio carries. The transcript, the
 * dialogue context and the intent the engine has reached so far live here
 * between them, keyed by the call id that is also the action's `channelRef`,
 * so the executor can find the action when the call ends (D-144).
 */
@Injectable()
export class VoiceCallsService {
  constructor(private readonly prisma: PrismaService) {}

  async open(input: {
    id: string;
    caseId: number;
    attempt: number;
    context: LiveDialogueContext;
    transcript: Turn[];
  }): Promise<VoiceCall> {
    return this.prisma.voiceCall.upsert({
      where: { id: input.id },
      create: {
        id: input.id,
        caseId: input.caseId,
        attempt: input.attempt,
        status: "dialing",
        context: input.context as unknown as Prisma.InputJsonValue,
        transcript: input.transcript as unknown as Prisma.InputJsonValue,
      },
      update: {
        status: "dialing",
        context: input.context as unknown as Prisma.InputJsonValue,
        transcript: input.transcript as unknown as Prisma.InputJsonValue,
        intent: null,
        seconds: 0,
        providerSid: null,
        recordingUrl: null,
      },
    });
  }

  dialed(id: string, providerSid: string): Promise<VoiceCall> {
    return this.prisma.voiceCall.update({ where: { id }, data: { providerSid } });
  }

  get(id: string): Promise<VoiceCall | null> {
    return this.prisma.voiceCall.findUnique({ where: { id } });
  }

  /** Appends turns and records where the engine believes the call stands. */
  speak(
    id: string,
    transcript: Turn[],
    patch: { status: VoiceCallStatus; intent?: VoiceIntent | "UNDECIDED" },
  ): Promise<VoiceCall> {
    return this.prisma.voiceCall.update({
      where: { id },
      data: {
        transcript: transcript as unknown as Prisma.InputJsonValue,
        status: patch.status,
        ...(patch.intent !== undefined ? { intent: patch.intent } : {}),
      },
    });
  }

  setStatus(id: string, status: VoiceCallStatus): Promise<VoiceCall> {
    return this.prisma.voiceCall.update({ where: { id }, data: { status } });
  }

  setRecording(id: string, recordingUrl: string): Promise<VoiceCall> {
    return this.prisma.voiceCall.update({ where: { id }, data: { recordingUrl } });
  }

  complete(id: string, intent: VoiceIntent, seconds: number): Promise<VoiceCall> {
    return this.prisma.voiceCall.update({
      where: { id },
      data: { status: "completed", intent, seconds },
    });
  }
}

export function transcriptOf(call: VoiceCall): Turn[] {
  return Array.isArray(call.transcript) ? (call.transcript as unknown as Turn[]) : [];
}

export function contextOf(call: VoiceCall): LiveDialogueContext {
  return call.context as unknown as LiveDialogueContext;
}
