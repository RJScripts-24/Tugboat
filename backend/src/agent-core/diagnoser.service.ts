import { Injectable, Logger } from "@nestjs/common";
import type { DiagnosisMethod, RootCause } from "@prisma/client";

import { CasesService } from "../cases/cases.service";
import { toCaseRef } from "../common/case-ref";
import { LlmFailure, LlmService } from "../conversation/llm.service";
import { diagnosisSchema } from "../conversation/schemas";
import { PolicyService } from "../policy/policy.service";
import { PrismaService } from "../prisma/prisma.service";
import { DetectorService } from "./detector.service";
import { RULES_VERSION, applyRules, type DiagnosisSignal } from "./diagnosis-rules";

export type DiagnosisOutcome = {
  caseRef: string;
  rootCause: RootCause;
  confidence: number;
  method: DiagnosisMethod;
  ruleId: string | null;
  escalated: boolean;
  reasoning: string[];
};

const SYSTEM_PROMPT = [
  "You diagnose why an Indian merchant's payment did not complete.",
  "Answer only with JSON matching this shape:",
  '{"root_cause": one of BANK_GATEWAY_DEGRADED|INSUFFICIENT_FUNDS|CUSTOMER_DISTRACTED|CARD_EXPIRED|MANDATE_REVOKED|UNKNOWN,',
  '"confidence": 0..1, "reasoning": one or two sentences, "evidence": array of short strings}.',
  "If the signals do not clearly support one cause, answer UNKNOWN with low confidence.",
  "Never guess to appear helpful: a wrong diagnosis sends the wrong message to a customer who did nothing wrong.",
].join(" ");

@Injectable()
export class DiagnoserService {
  private readonly logger = new Logger(DiagnoserService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cases: CasesService,
    private readonly detector: DetectorService,
    private readonly llm: LlmService,
    private readonly policy: PolicyService,
  ) {}

  /**
   * Rules first, model only when the rules cannot decide (ADR-5).
   *
   * Ordering is the whole architecture: a known error code has one correct
   * reading, and spending tokens plus nondeterminism to re-derive it would be
   * worse on every axis. The model earns its place only on genuine ambiguity.
   */
  async diagnose(caseId: number): Promise<DiagnosisOutcome> {
    const record = await this.prisma.case.findUniqueOrThrow({ where: { id: caseId } });
    const { pack } = await this.policy.getActive(record.merchantId);
    const floor = pack.escalation.confidenceFloor;

    const openIncident = await this.detector.openIncident(record.merchantId, record.simRunId ?? null);

    const signal: DiagnosisSignal = {
      caseType: record.type,
      failureCode: record.failureCode,
      failureReason: record.failureReason,
      failureSource: record.failureSource,
      instrument: record.instrument,
      gatewayDegraded: openIncident !== null,
    };

    const hit = applyRules(signal);

    if (hit) {
      return this.commit(record.id, {
        rootCause: hit.rootCause,
        confidence: hit.confidence,
        method: "RULES",
        ruleId: hit.rule.id,
        floor,
        reasoning: [
          `${record.failureReason ?? "The signal"} maps to ${hit.rootCause} in rules table ${RULES_VERSION} — one lookup, no model call.`,
          hit.rule.description + ".",
        ],
        tokens: { in: 0, out: 0 },
        latencyMs: 0,
      });
    }

    return this.askModel(record.id, signal, floor);
  }

  private async askModel(caseId: number, signal: DiagnosisSignal, floor: number) {
    // Only the masked, non-identifying facts reach the prompt (PRD 9.9): the
    // model needs the gateway's account of the failure, never the customer.
    const user = [
      `Case type: ${signal.caseType}`,
      `Gateway error code: ${signal.failureCode ?? "none reported"}`,
      `Gateway reason: ${signal.failureReason ?? "none reported"}`,
      `Reported by: ${signal.failureSource ?? "unknown"}`,
      `Instrument: ${signal.instrument ?? "unknown"}`,
      `Gateway-wide degradation currently detected: ${signal.gatewayDegraded ? "yes" : "no"}`,
    ].join("\n");

    try {
      const result = await this.llm.structured(
        { purpose: "diagnosis", system: SYSTEM_PROMPT, user, temperature: 0 },
        diagnosisSchema,
        { caseId },
      );

      return this.commit(caseId, {
        rootCause: result.value.root_cause,
        confidence: result.value.confidence,
        method: "LLM",
        ruleId: null,
        floor,
        reasoning: [
          "No rule matched: the reason code is unmapped, so the case went to the model.",
          result.value.reasoning,
        ],
        tokens: { in: result.tokensIn, out: result.tokensOut },
        latencyMs: result.latencyMs,
        model: `${result.provider} · ${result.model}`,
      });
    } catch (error) {
      if (!(error instanceof LlmFailure)) throw error;

      // The model produced something the schema refused twice, or could not be
      // reached at all. Neither is a diagnosis of UNKNOWN — it is no diagnosis,
      // so the case goes to a human rather than being recorded as an answer
      // nobody stands behind.
      this.logger.error(`Diagnosis for case ${caseId} produced no answer: ${error.message}`);

      return this.commit(caseId, {
        rootCause: "UNKNOWN",
        confidence: 0,
        method: "LLM",
        ruleId: null,
        floor,
        reasoning: [
          "The model's reply did not match the required schema on two attempts.",
          "No diagnosis was recorded; the case was escalated rather than guessed at.",
        ],
        tokens: { in: 0, out: 0 },
        latencyMs: 0,
        schemaFailure: true,
      });
    }
  }

  private async commit(
    caseId: number,
    input: {
      rootCause: RootCause;
      confidence: number;
      method: DiagnosisMethod;
      ruleId: string | null;
      floor: number;
      reasoning: string[];
      tokens: { in: number; out: number };
      latencyMs: number;
      model?: string;
      schemaFailure?: boolean;
    },
  ): Promise<DiagnosisOutcome> {
    const belowFloor = input.confidence < input.floor;
    const escalated = belowFloor || input.rootCause === "UNKNOWN";
    const caseRef = toCaseRef(caseId);

    const rows: { label: string; value: string; mono?: boolean; tone?: string }[] = [
      { label: "Root cause", value: input.rootCause, mono: true },
      {
        label: "Confidence",
        value: input.confidence.toFixed(2),
        mono: true,
        tone: belowFloor ? "halted" : undefined,
      },
      { label: "Threshold", value: `${input.floor.toFixed(2)} · escalate below`, mono: true },
      {
        label: "Method",
        value:
          input.method === "RULES"
            ? `rules-table · ${input.ruleId} · ${RULES_VERSION}`
            : `LLM · ${input.model ?? "unavailable"}`,
        mono: true,
      },
      {
        label: "Tokens",
        value:
          input.method === "RULES"
            ? "0 · no model call"
            : `${input.tokens.in} in · ${input.tokens.out} out`,
        mono: true,
      },
      { label: "Latency", value: `${input.latencyMs} ms`, mono: true },
    ];

    if (input.method === "LLM") {
      rows.push({ label: "Prompt", value: "Masked identifiers only — PII rule (PRD 9.9)" });
    }

    await this.cases.transition(
      caseId,
      escalated ? "escalated" : "diagnosed",
      {
        kind: "DIAGNOSED",
        title: `Diagnosed — ${input.rootCause.toLowerCase().replace(/_/g, " ")}`,
        summary: `confidence ${input.confidence.toFixed(2)} · ${
          input.method === "RULES" ? "rules table" : "LLM"
        }${escalated ? " · escalated" : ""}`,
        badge: {
          label: input.method === "RULES" ? "method: rules-table" : "method: LLM",
          tone: input.method === "RULES" ? "neutral" : "diagnosis",
        },
        body: { type: "diagnosis", reasoning: input.reasoning, rows },
      },
      {
        rootCause: input.rootCause,
        diagnosisConfidence: input.confidence,
        diagnosisMethod: input.method,
        diagnosisRuleId: input.ruleId,
        diagnosisAt: new Date(),
      },
    );

    this.logger.log(
      `${caseRef} diagnosed ${input.rootCause} @ ${input.confidence.toFixed(2)} via ${
        input.method
      }${escalated ? " (escalated)" : ""}`,
    );

    return {
      caseRef,
      rootCause: input.rootCause,
      confidence: input.confidence,
      method: input.method,
      ruleId: input.ruleId,
      escalated,
      reasoning: input.reasoning,
    };
  }
}
