import type { CaseType, RootCause } from "@prisma/client";

/**
 * The deterministic-first root-cause table (ADR-5).
 *
 * A known gateway error code has exactly one correct reading, and paying an LLM
 * to re-derive it every time would be slower, costlier and less predictable
 * than a lookup. The model is asked only when this table genuinely cannot
 * decide, which on a realistic batch is roughly one case in five.
 *
 * Versioned because a diagnosis is evidence: when the report says 91% accuracy,
 * the natural next question is "under which rules?", and every diagnosed case
 * records the rule id that fired.
 */
export const RULES_VERSION = "r1";

export type DiagnosisSignal = {
  caseType: CaseType;
  failureCode?: string | null;
  failureReason?: string | null;
  failureSource?: string | null;
  instrument?: string | null;
  /** True when the degradation monitor had an open incident when this failed. */
  gatewayDegraded: boolean;
};

export type DiagnosisRule = {
  id: string;
  description: string;
  rootCause: RootCause;
  confidence: number;
  matches: (signal: DiagnosisSignal) => boolean;
};

function reason(signal: DiagnosisSignal): string {
  return `${signal.failureReason ?? ""} ${signal.failureCode ?? ""}`.toLowerCase();
}

function has(signal: DiagnosisSignal, ...needles: string[]): boolean {
  const haystack = reason(signal);
  return needles.some((needle) => haystack.includes(needle));
}

/**
 * Evaluated in order; the first match wins.
 *
 * Ordering is load-bearing where a signal could satisfy two rules. A revoked
 * mandate that also reports a bank error is a revoked mandate — no amount of
 * retrying fixes it — so R-01 sits above the gateway rules deliberately.
 */
export const DIAGNOSIS_RULES: DiagnosisRule[] = [
  {
    id: "R-01",
    description: "Customer withdrew the e-mandate at their bank",
    rootCause: "MANDATE_REVOKED",
    confidence: 0.99,
    matches: (s) => has(s, "mandate_revoked", "mandate_cancelled", "mandate_not_active"),
  },
  {
    id: "R-02",
    description: "Issuer declined on expiry, not on balance",
    rootCause: "CARD_EXPIRED",
    confidence: 0.97,
    matches: (s) => has(s, "card_expired", "expired_card", "invalid_expiry"),
  },
  {
    id: "R-03",
    description: "Issuer declined on balance; instrument is live",
    rootCause: "INSUFFICIENT_FUNDS",
    confidence: 0.96,
    matches: (s) => has(s, "insufficient_funds", "insufficient_balance", "not_enough_balance"),
  },
  {
    id: "R-04",
    description: "Failure landed inside an open gateway degradation window",
    rootCause: "BANK_GATEWAY_DEGRADED",
    confidence: 0.93,
    matches: (s) =>
      s.gatewayDegraded && has(s, "timeout", "gateway", "server_error", "bank_not_available"),
  },
  {
    id: "R-05",
    description: "Explicit gateway or upstream bank error",
    rootCause: "BANK_GATEWAY_DEGRADED",
    confidence: 0.88,
    matches: (s) =>
      has(s, "gateway_error", "collect_timeout", "upi_timeout", "bank_not_available", "gateway_timeout"),
  },
  {
    id: "R-06",
    description: "Cart abandoned with no gateway error to read",
    rootCause: "CUSTOMER_DISTRACTED",
    confidence: 0.82,
    matches: (s) => s.caseType === "CHECKOUT_ABANDONED" && !s.failureReason && !s.failureCode,
  },
  {
    id: "R-07",
    description: "Invoice passed its due date with no payment attempt to explain",
    rootCause: "CUSTOMER_DISTRACTED",
    confidence: 0.78,
    matches: (s) => s.caseType === "INVOICE_OVERDUE" && !s.failureReason && !s.failureCode,
  },
];

export type RuleHit = {
  rule: DiagnosisRule;
  rootCause: RootCause;
  confidence: number;
};

/**
 * Returns null when nothing matches, which is the signal to ask the model.
 *
 * Deliberately conservative: an unmapped or contradictory code falls through
 * rather than being forced into the nearest-looking bucket, because a confident
 * wrong diagnosis sends the wrong message to a customer who did nothing wrong.
 */
export function applyRules(signal: DiagnosisSignal): RuleHit | null {
  for (const rule of DIAGNOSIS_RULES) {
    if (rule.matches(signal)) {
      return { rule, rootCause: rule.rootCause, confidence: rule.confidence };
    }
  }

  return null;
}
