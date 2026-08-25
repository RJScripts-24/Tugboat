import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Prisma, Sentiment } from "@prisma/client";

import { CasesService } from "../cases/cases.service";
import { toCaseRef } from "../common/case-ref";
import type { PolicyChannel } from "../policy/policy-pack";
import { PolicyService } from "../policy/policy.service";
import { PrismaService } from "../prisma/prisma.service";
import { ACTION_QUEUE, type ActionQueue } from "../queue/action-queue.interface";
import { LlmSchemaError, LlmService } from "./llm.service";
import { matchOptOut } from "./opt-out";
import { sentimentSchema } from "./schemas";

/**
 * What happens when a customer answers.
 *
 * Order matters and is the whole design. The opt-out keyword list runs first,
 * deterministically, before any model is consulted: the one rule that cannot be
 * switched off must not depend on an API being reachable. Only replies that are
 * not opt-outs go to the classifier, and its verdict is Zod-parsed before it can
 * touch a case.
 *
 * Hardship is read from the classifier's own reasoning plus a phrase list, and
 * it does not halt the case — it escalates it. Somebody saying money is tight
 * is not somebody saying go away.
 */

const HARDSHIP_PHRASES = [
  "tight",
  "hardship",
  "cannot afford",
  "can't afford",
  "no money",
  "lost my job",
  "medical",
  "paisa nahi",
  "paise nahi",
  "dikkat",
  "majboori",
  "dispute",
  "disputed",
  "not my charge",
  "fraud",
];

const SYSTEM_PROMPT = [
  "You classify a single inbound customer reply to a payment reminder from an Indian merchant.",
  "Replies may be in English, Hindi, or Hinglish written in Latin script.",
  "Score runs from -1 (hostile) through 0 (neutral) to +1 (positive and cooperative).",
  "Financial hardship or a disputed charge is negative, not neutral.",
  'Answer only with JSON: {"sentiment": positive|neutral|negative|opt-out, "score": number, "reasoning": string}.',
].join(" ");

/** A case in one of these has nowhere left to move; a late reply is recorded, not acted on. */
const TERMINAL_STAGES = ["recovered", "halted", "exhausted"];

/** The wire spells it "opt-out"; a hyphen is not a legal Prisma identifier. */
const TO_ENUM: Record<string, Sentiment> = {
  positive: "positive",
  neutral: "neutral",
  negative: "negative",
  "opt-out": "opt_out",
};

export type InboundReply = {
  caseId: number;
  channel: PolicyChannel;
  text: string;
  at?: Date;
};

export type InboundOutcome = {
  caseRef: string;
  sentiment: Sentiment;
  score: number;
  matchedKeyword: string | null;
  hardship: boolean;
  consequence: "halted" | "escalated" | "continues";
};

@Injectable()
export class InboundService {
  private readonly logger = new Logger(InboundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cases: CasesService,
    private readonly llm: LlmService,
    private readonly policy: PolicyService,
    @Inject(ACTION_QUEUE) private readonly queue: ActionQueue,
  ) {}

  async handle(reply: InboundReply): Promise<InboundOutcome> {
    const record = await this.prisma.case.findUnique({
      where: { id: reply.caseId },
      include: { customer: true },
    });

    if (!record) {
      throw new NotFoundException({ error: `Case ${toCaseRef(reply.caseId)} not found.` });
    }

    const { pack } = await this.policy.getActive(record.merchantId);
    const keyword = matchOptOut(reply.text);

    const classified = keyword
      ? { sentiment: "opt_out" as Sentiment, score: -1, reasoning: `Opt-out keyword "${keyword}".` }
      : await this.classify(reply);

    // Two layers, one consequence. The keyword list is deliberately strict about
    // where a word appears; the classifier catches "please stop messaging me".
    // Either verdict closes the customer on every channel, permanently.
    const optedOut = keyword !== null || classified.sentiment === "opt_out";
    const hardship = !optedOut && isHardship(reply.text, classified.reasoning);

    // Recorded on the case rather than parsed back out of the timeline: the
    // PolicyGate reads these on every check, and the score is what the
    // threshold compares against.
    await this.prisma.case.update({
      where: { id: record.id },
      data: {
        lastSentiment: classified.sentiment,
        lastSentimentScore: classified.score,
        ...(hardship ? { hardshipFlaggedAt: new Date() } : {}),
      },
    });

    if (optedOut) {
      await this.prisma.customer.update({
        where: { id: record.customerId },
        data: { optedOutAt: reply.at ?? new Date() },
      });
    }

    const consequence = this.consequenceOf(
      classified,
      optedOut,
      hardship,
      pack.sentimentThreshold,
      pack.rules.sentiment,
    );

    await this.cases.appendEvent(record.id, {
      kind: "CUSTOMER_REPLY",
      occurredAt: reply.at,
      title: `${record.customer.name} replied`,
      summary: `Inbound on ${reply.channel} · ${keyword ? "opt-out keyword matched" : `classified ${wire(classified.sentiment)}`}`,
      badge: {
        label: keyword ? "opt-out keyword" : wire(classified.sentiment),
        tone:
          classified.sentiment === "positive"
            ? "recovered"
            : classified.sentiment === "negative" || classified.sentiment === "opt_out"
              ? "halted"
              : "neutral",
      },
      body: {
        type: "reply",
        channel: reply.channel,
        text: reply.text,
        sentiment: wire(classified.sentiment),
        rows: [
          { label: "Channel", value: reply.channel },
          {
            label: "Sentiment",
            value: `${wire(classified.sentiment)} · ${classified.score.toFixed(2)}`,
            mono: true,
          },
          {
            label: "Classified by",
            value: keyword ? "Keyword list — no model call" : "LLM · sentiment lane",
            mono: true,
          },
          { label: "Consequence", value: CONSEQUENCE_COPY[consequence] },
        ],
      } as unknown as Prisma.InputJsonValue,
    });

    await this.applyConsequence(record.id, record.stage, consequence, classified, keyword, optedOut);

    this.logger.log(
      `${toCaseRef(record.id)} reply on ${reply.channel} -> ${wire(classified.sentiment)} (${consequence})`,
    );

    return {
      caseRef: toCaseRef(record.id),
      sentiment: classified.sentiment,
      score: classified.score,
      matchedKeyword: keyword,
      hardship,
      consequence,
    };
  }

  private async classify(reply: InboundReply) {
    try {
      const result = await this.llm.structured(
        { purpose: "sentiment", system: SYSTEM_PROMPT, user: reply.text, temperature: 0 },
        sentimentSchema,
        { caseId: reply.caseId },
      );

      return {
        sentiment: TO_ENUM[result.value.sentiment],
        score: result.value.score,
        reasoning: result.value.reasoning,
      };
    } catch (error) {
      if (!(error instanceof LlmSchemaError)) throw error;

      // An unreadable classification is not a neutral reply. Treating it as
      // neutral would let the agent carry on nudging somebody whose answer it
      // never understood, so the case goes to a person instead.
      this.logger.error(`Sentiment classification failed for case ${reply.caseId}: ${error.issues}`);
      return {
        sentiment: "negative" as Sentiment,
        score: -1,
        reasoning: "The classifier could not produce a valid reading of this reply.",
      };
    }
  }

  private consequenceOf(
    classified: { sentiment: Sentiment; score: number },
    optedOut: boolean,
    hardship: boolean,
    threshold: number,
    sentimentRuleOn: boolean,
  ): InboundOutcome["consequence"] {
    if (optedOut) return "halted";
    if (hardship) return "escalated";
    if (sentimentRuleOn && classified.sentiment === "negative" && classified.score <= -threshold) {
      return "halted";
    }
    return "continues";
  }

  private async applyConsequence(
    caseId: number,
    stage: string,
    consequence: InboundOutcome["consequence"],
    classified: { sentiment: Sentiment; score: number },
    keyword: string | null,
    optedOut: boolean,
  ): Promise<void> {
    if (consequence === "continues") return;

    // Whatever else happens, scheduled work stops. A halt that leaves a nudge
    // in the queue is a delay, not a halt.
    await this.cancelPending(caseId);

    // A reply can arrive after the case has closed — the customer answers the
    // morning after the deadline expired, or the payment landed while the
    // message was in flight. The reply is still recorded above; there is simply
    // no stage left to move to, and attempting one used to throw a 400 out of
    // the endpoint (B-19).
    if (TERMINAL_STAGES.includes(stage)) {
      this.logger.log(
        `Reply arrived on a case that is already ${stage}; recorded, no transition attempted`,
      );
      return;
    }

    if (consequence === "halted") {
      await this.cases.transition(caseId, "halted", {
        kind: "HALTED",
        title: optedOut ? "Contact halted — opt-out" : "Contact halted — negative sentiment",
        summary: optedOut
          ? `${keyword ? `"${keyword}" received` : "Read as an opt-out"} — every channel closed for this customer, permanently`
          : `Reply classified negative at ${classified.score.toFixed(2)} — handed to a person`,
        badge: { label: "HALTED", tone: "halted" },
        body: {
          type: "facts",
          rows: [
            {
              label: "Trigger",
              value: keyword ?? (optedOut ? "Classifier read it as an opt-out" : "Negative sentiment"),
              mono: true,
            },
            {
              label: "Detected by",
              value: keyword
                ? "Keyword list — deterministic, no model call"
                : "Sentiment classifier — the second of the two opt-out layers",
            },
            {
              label: "Rule",
              value: optedOut
                ? "Opt-out halt — the one rule that cannot be switched off"
                : "Negative-sentiment halt",
            },
            { label: "Scope", value: optedOut ? "Every channel, permanently" : "This case" },
            { label: "Scheduled work", value: "Cancelled" },
          ],
        } as unknown as Prisma.InputJsonValue,
      });
      return;
    }

    if (stage === "escalated") return;

    await this.cases.transition(caseId, "escalated", {
      kind: "ESCALATED",
      title: "Escalated to a human",
      summary: "Hardship or dispute language in the reply — the agent stood down",
      badge: { label: "sent to approvals", tone: "waiting" },
      body: {
        type: "facts",
        rows: [
          { label: "Gate", value: "hardship_language", mono: true },
          { label: "Heard on", value: "Inbound reply" },
          { label: "Agent action", value: "Stood down — no further contact without a person" },
        ],
      } as unknown as Prisma.InputJsonValue,
    });
  }

  /**
   * Drops every queued job for a case.
   *
   * A halt that leaves a scheduled nudge in the queue is not a halt — it is a
   * delay. The job ids are derived rather than stored, so the whole plausible
   * range is cancelled; cancelling an id that was never scheduled is a no-op.
   */
  private async cancelPending(caseId: number): Promise<void> {
    for (let attempt = 0; attempt <= 8; attempt += 1) {
      await this.queue.cancel(`case:${caseId}:step:${attempt}`);
    }

    const promises = await this.prisma.paymentPromise.findMany({
      where: { caseId, status: "PENDING" },
      select: { id: true },
    });

    for (const promise of promises) {
      await this.queue.cancel(`promise:${promise.id}`);
    }
  }
}

const CONSEQUENCE_COPY: Record<InboundOutcome["consequence"], string> = {
  halted: "Immediate halt on every channel — the one rule that cannot be switched off",
  escalated: "Contact halted and the case handed to a human",
  continues: "Case continues inside its bounds",
};

function isHardship(text: string, reasoning: string): boolean {
  const haystack = `${text} ${reasoning}`.toLowerCase();
  return HARDSHIP_PHRASES.some((phrase) => haystack.includes(phrase));
}

function wire(sentiment: Sentiment): string {
  return sentiment === "opt_out" ? "opt-out" : sentiment;
}
