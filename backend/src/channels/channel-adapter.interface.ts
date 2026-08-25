import type { GatePass } from "../policy/gate-pass";
import type { PolicyChannel } from "../policy/policy-pack";
import type { CopyContext } from "./message-copy";

/**
 * The only way out of the building.
 *
 * `send` takes a `GatePass` first because the PolicyGate is the sole issuer of
 * that type: a code path from the Planner to a customer that skipped the gate
 * cannot be written, only cast into existence, and the architecture test looks
 * for those casts.
 *
 * Every adapter is simulated in Stage 5 and says so in `mode`, which the Case
 * Detail timeline prints beside the message. Stage 10 swaps implementations
 * behind this interface; nothing above it changes.
 */

export type ChannelMode = "simulated" | "real";

export type Turn = { speaker: "BOA" | "CUSTOMER"; text: string };

export type VoiceIntent = "PROMISED_TO_PAY" | "HARDSHIP_DECLARED" | "NO_ANSWER";

/** How the scripted counterpart behaves. Stage 8's personas replace the default. */
export type VoiceCounterpart = "promise" | "decline" | "no-answer";

/**
 * A body that has already been read and signed off by a person.
 *
 * An approver is shown the exact message and may rewrite it before saying yes,
 * so what leaves the building has to be that text rather than copy re-derived
 * at send time from a case that has since moved. Only the message channels
 * honour it: a retry has no body, and a voice call is a conversation rather
 * than a script.
 */
export type ApprovedBody = { lines: string[]; subject?: string };

export type SendRequest = {
  caseId: number;
  attempt: number;
  /** Masked at the boundary before it reaches a log or a prompt. */
  to: string;
  copy: CopyContext;
  counterpart?: VoiceCounterpart;
  /** Set when a promise is being sought, so the script can name a date. */
  promiseDateLabel?: string;
  approved?: ApprovedBody;
};

export type RetryDetail = {
  kind: "retry";
  captured: boolean;
  gatewayLatencyMs: number;
  failureReason: string | null;
};

export type MessageDetail = {
  kind: "message";
  channel: "WHATSAPP" | "EMAIL";
  subject?: string;
  lines: string[];
  link: string;
  template?: string;
  status: string;
};

export type VoiceDetail = {
  kind: "voice";
  seconds: number;
  transcript: Turn[];
  summary: string;
  intent: VoiceIntent;
  language: string;
  turnsFromModel: number;
};

export type ChannelDetail = RetryDetail | MessageDetail | VoiceDetail;

export type ChannelSendResult = {
  /** Provider-side id: Razorpay payment id, Twilio SID, Resend id, or a simulated equivalent. */
  channelRef: string;
  mode: ChannelMode;
  costPaise: number;
  detail: ChannelDetail;
};

export interface ChannelAdapter {
  readonly channel: PolicyChannel;
  /** Never inferred and never hidden: a simulated send says so everywhere it appears (Rule 5). */
  readonly mode: ChannelMode;
  send(pass: GatePass, request: SendRequest): Promise<ChannelSendResult>;
}

export const CHANNEL_ADAPTERS = Symbol("CHANNEL_ADAPTERS");

/** Mode strings the UI prints verbatim (`CHANNEL_META` in the frontend). */
export const CHANNEL_MODE_LABEL: Record<PolicyChannel, string> = {
  RETRY: "Simulated Razorpay retry · no live endpoint",
  WHATSAPP: "Simulated WhatsApp · no message leaves the process",
  EMAIL: "Simulated email · no message leaves the process",
  VOICE: "Simulated telephony · labelled",
};
