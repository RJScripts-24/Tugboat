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
  /**
   * Whether the re-presentation captures, decided outside the agent.
   *
   * Only the simulator sets it, and only it can: whether the money is there
   * depends on the *true* cause and the customer's actual balance, neither of
   * which the agent may see. Left unset, the adapter falls back to its own
   * seeded odds against the diagnosis it was given — which is the right answer
   * for a demo and the wrong one for a graded batch, because it would make a
   * wrong diagnosis cost nothing.
   */
  captured?: boolean;
};

export type RetryDetail = {
  kind: "retry";
  captured: boolean;
  gatewayLatencyMs: number;
  failureReason: string | null;
  /**
   * Set by the real Razorpay lane, where a capture never happens at send
   * time: the link is live and the money arrives by webhook. The executor
   * renders this as "awaiting", never as a decline (D-124).
   */
  awaiting?: string;
  link?: string;
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
  /** The stitched recording, when `VOICE_TTS` is on (D-126). Telephony stays simulated either way. */
  audioUrl?: string | null;
  recording?: string | null;
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

/**
 * The HTTP function the real adapters call, as an injectable.
 *
 * Node's global `fetch` is the production value; a unit test hands the
 * adapter a recorder instead and asserts the exact request each provider
 * receives. A default parameter would do the same job, except that Nest tries
 * to resolve every constructor parameter and has no provider for `Function`.
 */
export const FETCH = Symbol("FETCH");
export type Fetch = typeof fetch;

/** Mode strings the UI prints verbatim (`CHANNEL_META` in the frontend). */
export const CHANNEL_MODE_LABEL: Record<PolicyChannel, string> = {
  RETRY: "Simulated Razorpay retry · no live endpoint",
  WHATSAPP: "Simulated WhatsApp · no message leaves the process",
  EMAIL: "Simulated email · no message leaves the process",
  VOICE: "Simulated telephony · labelled",
};

/** The same, for a lane that is real — the frontend's own wording for each. */
export const REAL_CHANNEL_MODE_LABEL: Record<PolicyChannel, string> = {
  RETRY: "Razorpay test mode · real endpoint",
  WHATSAPP: "Twilio sandbox · real message",
  EMAIL: "Resend · real message",
  VOICE: "Simulated telephony · labelled",
};

/** What the timeline prints beside a send: never inferred from config, always from the result. */
export function channelModeLabel(channel: PolicyChannel, mode: ChannelMode): string {
  return mode === "real" ? REAL_CHANNEL_MODE_LABEL[channel] : CHANNEL_MODE_LABEL[channel];
}
