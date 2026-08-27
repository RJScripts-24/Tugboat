/**
 * The policy pack, as data.
 *
 * This module is the whole argument of the Policies page (PRD 6.3, page 7):
 * every bound the agent works inside is a field on one object, versioned and
 * diffable, rather than a constant buried in the executor. The page edits this
 * object; the PolicyGate reads it; the Evidence Report counts how often each
 * field stopped something. Three different views of one record.
 *
 * `GET /policies` returns the pack in force, its version, and every revision
 * that led to it; `PUT /policies` validates a submitted pack, diffs it, cuts a
 * new version and writes a `POLICY_CHANGED` row on the ledger's policy chain.
 * Money is in paise throughout, matching the schema; times of day are minutes
 * past midnight IST, because "21:00" is a rendering of a number and not the
 * number itself.
 *
 * The pack no longer has a copy here. It used to, and the note above it said
 * the values were "the same values the Case Detail bounds panel reports, the
 * same thresholds the Approvals Queue names" — which was true because somebody
 * kept them true. There is one pack now, the PolicyGate reads it on every
 * check, and a page that disagreed with the enforcement would have to disagree
 * with the row the enforcement read.
 *
 * `DEFAULT_PACK` survives, and only as what "Reset to defaults" restores: the
 * shipped v4 constants, which are a starting point rather than a claim about
 * what is in force.
 */

import { CHANNEL_META, type Channel } from "@/lib/case-detail-data";
import type { Tone } from "@/lib/dashboard-data";

const RUPEE = 100; // paise per rupee

/* ------------------------------------------------------------------ */
/* The pack                                                            */
/* ------------------------------------------------------------------ */

export type StoppingRuleKey = "opt_out" | "sentiment" | "deadline" | "attempt_cap";

export type EscalationGateKey =
  | "discount"
  | "value_threshold"
  | "b2b_always"
  | "confidence_floor"
  | "hardship";

export type PolicyPack = {
  /** Contact bounds - how much rope one case gets. */
  contact: {
    maxAttempts: number;
    coolDownHours: number;
    channelCaps: Record<Channel, number>;
  };
  /** Quiet hours, as minutes past midnight IST. Blocked from `start` to `end`. */
  quiet: {
    startMinutes: number;
    endMinutes: number;
    /** A retry contacts nobody, so the window need not hold it. */
    exemptSilentRetries: boolean;
  };
  /** Stopping rules, on or off. `opt_out` is locked at the type level by the UI. */
  rules: Record<StoppingRuleKey, boolean>;
  /** How sure the classifier must be before a negative reply halts a case. */
  sentimentThreshold: number;
  escalation: {
    /** The most a human may approve, in percent. Boa may never offer any. */
    discountCapPercent: number;
    valueThresholdPaise: number;
    b2bAlways: boolean;
    confidenceFloor: number;
    hardship: boolean;
  };
  mandate: {
    maxPerCycle: number;
    spacingDays: number;
    /** Re-present after salary lands rather than the next morning. */
    alignToPayday: boolean;
  };
  channels: Record<Channel, boolean>;
};

/**
 * The shipped v4 constants — what "Reset to defaults" restores.
 *
 * Built fresh on every call so a component cannot mutate the baseline by
 * editing a nested object it was handed: the page compares against a baseline
 * to decide what is unsaved, and a baseline that drifts makes the diff lie.
 */
export function shippedDefaults(): PolicyPack {
  return {
    contact: {
      maxAttempts: 4,
      coolDownHours: 20,
      channelCaps: { WHATSAPP: 2, EMAIL: 2, VOICE: 1, RETRY: 2 },
    },
    quiet: {
      startMinutes: 21 * 60,
      endMinutes: 9 * 60,
      exemptSilentRetries: true,
    },
    rules: {
      opt_out: true,
      sentiment: true,
      deadline: true,
      attempt_cap: true,
    },
    sentimentThreshold: 0.7,
    escalation: {
      discountCapPercent: 15,
      valueThresholdPaise: 25_000 * RUPEE,
      b2bAlways: true,
      confidenceFloor: 0.6,
      hardship: true,
    },
    mandate: {
      maxPerCycle: 3,
      spacingDays: 3,
      alignToPayday: true,
    },
    channels: { WHATSAPP: true, EMAIL: true, VOICE: true, RETRY: true },
  };
}

/** "Reset to defaults" restores the shipped pack. */
export const DEFAULT_PACK: PolicyPack = shippedDefaults();

/**
 * The version the pack shipped as.
 *
 * Kept only as the label for those defaults. What is *in force* is whatever
 * `GET /policies` says, which is why every page that prints a version now takes
 * it from the server rather than importing a constant — the bug that constant
 * caused is documented in the note on the Policies page's own version fold.
 */
export const SHIPPED_VERSION = "v4";

/** A deep copy, so an editor never writes through to the baseline it diffs against. */
export function clonePack(pack: PolicyPack): PolicyPack {
  return {
    contact: { ...pack.contact, channelCaps: { ...pack.contact.channelCaps } },
    quiet: { ...pack.quiet },
    rules: { ...pack.rules },
    sentimentThreshold: pack.sentimentThreshold,
    escalation: { ...pack.escalation },
    mandate: { ...pack.mandate },
    channels: { ...pack.channels },
  };
}

/* ------------------------------------------------------------------ */
/* Vocabulary                                                          */
/* ------------------------------------------------------------------ */

/**
 * A stopping rule, in the words that go beside its switch.
 *
 * `explain` is the rule; `effect` is what happens when it fires. The two are
 * separate because a merchant deciding whether to keep a rule on is asking the
 * second question, and a page that only answers the first is a page that reads
 * like a specification rather than a control.
 */
export const STOPPING_RULES: {
  key: StoppingRuleKey;
  /** The counter in `getRuleFirings` that measures it. */
  firingKey: string;
  label: string;
  explain: string;
  effect: string;
  /** Ends the case rather than deferring an action. */
  terminal: boolean;
  /** Cannot be switched off, at any price. */
  locked?: boolean;
  /** What switching it off would actually mean. */
  offWarning?: string;
  tone: Tone;
}[] = [
  {
    key: "opt_out",
    firingKey: "opt_out",
    label: "Opt-out keyword halt",
    explain:
      "A reply containing a stop word closes every channel for that customer, immediately and permanently.",
    effect: "HALTED on all channels · every later action on them refused at the gate",
    terminal: true,
    locked: true,
    tone: "halted",
  },
  {
    key: "sentiment",
    firingKey: "sentiment",
    label: "Negative-sentiment halt",
    explain:
      "A reply the classifier reads as strongly negative stops the agent and hands the case to a person.",
    effect: "HALTED and escalated · no further contact without a human decision",
    terminal: true,
    offWarning:
      "With this off an angry customer gets nudged again. The complaint that follows costs more than the case.",
    tone: "halted",
  },
  {
    key: "deadline",
    firingKey: "deadline",
    label: "Deadline expiry",
    explain:
      "Past the case deadline the money stops being recoverable and starts being a stale debt.",
    effect: "Closed EXHAUSTED · nothing is chased after its deadline",
    terminal: true,
    offWarning: "With this off a case can be chased indefinitely. Nothing else would close it.",
    tone: "neutral",
  },
  {
    key: "attempt_cap",
    firingKey: "attempt_cap",
    label: "Max-attempts exhaustion",
    explain:
      "When the contact bounds above are spent the case closes rather than looking for another channel.",
    effect: "Closed EXHAUSTED · the reason and the attempt count go to the ledger",
    terminal: true,
    offWarning:
      "With this off the attempt cap becomes advisory: a case would only ever end by recovering, expiring or being halted.",
    tone: "waiting",
  },
];

/**
 * The escalation gates (PRD 9.6) - the actions Boa plans, checks, and then
 * refuses to take alone.
 *
 * The wording matches `GATE_META` in `lib/approvals-data` on purpose: the
 * Approvals Queue names the gate that stopped a request, and this page is
 * where that same sentence is configured. Two phrasings of one rule is two
 * answers a panelist can catch you between.
 */
export const ESCALATION_GATES: {
  key: EscalationGateKey;
  label: string;
  explain: string;
  /** The gate id the Approvals Queue reports against, where there is one. */
  queueGate?: string;
  locked?: boolean;
  tone: Tone;
}[] = [
  {
    key: "discount",
    label: "Any discount",
    explain:
      "There is no threshold under which the agent may give money away. Every concession is a person's decision.",
    queueGate: "discount_requires_approval",
    locked: true,
    tone: "waiting",
  },
  {
    key: "value_threshold",
    label: "Value above threshold",
    explain: "Cases carrying more than this are worked by a person, not by an agent.",
    queueGate: "b2b_high_value",
    tone: "waiting",
  },
  {
    key: "b2b_always",
    label: "B2B accounts always escalate",
    explain:
      "A business relationship is not a nudge target. Receivables go to whoever owns the account.",
    tone: "waiting",
  },
  {
    key: "confidence_floor",
    label: "Diagnosis confidence floor",
    explain:
      "Under this the root cause is not trusted, so the agent escalates rather than guessing an intervention.",
    queueGate: "confidence_below_threshold",
    tone: "diagnosis",
  },
  {
    key: "hardship",
    label: "Hardship or dispute language",
    explain:
      "Financial hardship or a disputed charge stops the agent immediately and hands the case over.",
    queueGate: "hardship_language",
    tone: "halted",
  },
];

/** The words that close a customer for good. Hindi included, because the customers are. */
export const OPT_OUT_KEYWORDS = ["STOP", "UNSUBSCRIBE", "OPT OUT", "BAND KARO", "बंद करो", "मत भेजो"];

/**
 * Channels, with the mode indicator the PRD asks for.
 *
 * `mode` comes from `CHANNEL_META` rather than being restated here: whether a
 * channel is a real send or a labelled simulation is a claim this product makes
 * in four places, and it has to be the same claim in all of them.
 */
export const CHANNEL_ROWS: {
  channel: Channel;
  /** A retry reaches the gateway, not the customer. */
  silent: boolean;
  note: string;
}[] = [
  {
    channel: "WHATSAPP",
    silent: false,
    note: "First rung of most ladders — highest read rate, lowest cost per contact",
  },
  {
    channel: "EMAIL",
    silent: false,
    note: "Carries the payment link and survives being read hours later",
  },
  {
    channel: "VOICE",
    silent: false,
    note: "Hinglish, one call only, and only where a nudge has already been ignored",
  },
  {
    channel: "RETRY",
    silent: true,
    note: "Re-presents the payment. Contacts nobody, so quiet hours do not hold it",
  },
];

export { CHANNEL_META };

/* ------------------------------------------------------------------ */
/* Time of day                                                         */
/* ------------------------------------------------------------------ */

/** 1260 -> "21:00". The pack stores minutes; only the edge renders them. */
export function formatClock(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Length of the blocked window, which wraps midnight. */
export function quietSpanMinutes(startMinutes: number, endMinutes: number): number {
  return ((endMinutes - startMinutes) % 1440 + 1440) % 1440;
}

/** Whether a given minute of the day falls inside the blocked window. */
export function isQuiet(minute: number, startMinutes: number, endMinutes: number): boolean {
  const span = quietSpanMinutes(startMinutes, endMinutes);
  if (span === 0) return false;
  return ((minute - startMinutes) % 1440 + 1440) % 1440 < span;
}

/* ------------------------------------------------------------------ */
/* The diff                                                            */
/* ------------------------------------------------------------------ */

export type PolicyChange = {
  /** Dotted path, exactly as the ledger payload records it. */
  path: string;
  label: string;
  from: string;
  to: string;
  /** Widening a bound is not the same act as tightening one. */
  direction: "looser" | "tighter" | "changed";
};

/**
 * What a save would actually write.
 *
 * Computed field by field rather than by deep-comparing JSON, because the
 * ledger entry has to be readable by a person six months later: "contact
 * .maxAttempts 4 → 6" is an audit row, and a blob of before-and-after JSON is
 * a diff nobody reads.
 *
 * `direction` exists because the honest question about a policy change is not
 * whether it changed but which way it went. Loosening a bound is the thing a
 * compliance reviewer is looking for, so the page marks it rather than making
 * them work it out from the numbers.
 */
export function diffPacks(from: PolicyPack, to: PolicyPack): PolicyChange[] {
  const out: PolicyChange[] = [];

  const num = (
    path: string,
    label: string,
    a: number,
    b: number,
    render: (value: number) => string,
    /** Which way a bigger number goes. */
    biggerIs: "looser" | "tighter",
  ) => {
    if (a === b) return;
    out.push({
      path,
      label,
      from: render(a),
      to: render(b),
      direction: b > a ? biggerIs : biggerIs === "looser" ? "tighter" : "looser",
    });
  };

  const flag = (
    path: string,
    label: string,
    a: boolean,
    b: boolean,
    /** Which way switching it on goes, or "changed" where neither way is looser. */
    onIs: PolicyChange["direction"],
  ) => {
    if (a === b) return;
    const inverse =
      onIs === "changed" ? "changed" : onIs === "looser" ? "tighter" : "looser";
    out.push({
      path,
      label,
      from: a ? "on" : "off",
      to: b ? "on" : "off",
      direction: b ? onIs : inverse,
    });
  };

  const plain = (value: number) => String(value);
  const hours = (value: number) => `${value}h`;
  const money = (paise: number) =>
    `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(paise / 100)}`;

  num("contact.maxAttempts", "Attempts per case", from.contact.maxAttempts, to.contact.maxAttempts, plain, "looser");
  num("contact.coolDownHours", "Cool-down between contacts", from.contact.coolDownHours, to.contact.coolDownHours, hours, "tighter");

  for (const { channel } of CHANNEL_ROWS) {
    num(
      `contact.channelCaps.${channel}`,
      `${CHANNEL_META[channel].short} cap`,
      from.contact.channelCaps[channel],
      to.contact.channelCaps[channel],
      plain,
      "looser",
    );
  }

  num("quiet.startMinutes", "Quiet hours start", from.quiet.startMinutes, to.quiet.startMinutes, formatClock, "looser");
  num("quiet.endMinutes", "Quiet hours end", from.quiet.endMinutes, to.quiet.endMinutes, formatClock, "tighter");
  flag("quiet.exemptSilentRetries", "Silent retries exempt", from.quiet.exemptSilentRetries, to.quiet.exemptSilentRetries, "looser");

  for (const rule of STOPPING_RULES) {
    flag(`rules.${rule.key}`, rule.label, from.rules[rule.key], to.rules[rule.key], "tighter");
  }
  num(
    "sentimentThreshold",
    "Sentiment halt threshold",
    from.sentimentThreshold,
    to.sentimentThreshold,
    (value) => value.toFixed(2),
    "looser",
  );

  num("escalation.discountCapPercent", "Discount a human may approve", from.escalation.discountCapPercent, to.escalation.discountCapPercent, (value) => `${value}%`, "looser");
  num("escalation.valueThresholdPaise", "Escalation value threshold", from.escalation.valueThresholdPaise, to.escalation.valueThresholdPaise, money, "looser");
  flag("escalation.b2bAlways", "B2B always escalates", from.escalation.b2bAlways, to.escalation.b2bAlways, "tighter");
  num("escalation.confidenceFloor", "Confidence floor", from.escalation.confidenceFloor, to.escalation.confidenceFloor, (value) => value.toFixed(2), "tighter");
  flag("escalation.hardship", "Hardship language gate", from.escalation.hardship, to.escalation.hardship, "tighter");

  num("mandate.maxPerCycle", "Re-presentations per cycle", from.mandate.maxPerCycle, to.mandate.maxPerCycle, plain, "looser");
  num("mandate.spacingDays", "Days between re-presentations", from.mandate.spacingDays, to.mandate.spacingDays, (value) => `${value}d`, "tighter");
  // Scheduling, not a bound: retrying after payday is neither more nor less
  // permissive than retrying the next morning, it is just likelier to work.
  flag("mandate.alignToPayday", "Align retries to payday", from.mandate.alignToPayday, to.mandate.alignToPayday, "changed");

  for (const { channel } of CHANNEL_ROWS) {
    flag(`channels.${channel}`, `${CHANNEL_META[channel].short} channel`, from.channels[channel], to.channels[channel], "looser");
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Revision history                                                    */
/* ------------------------------------------------------------------ */

export type PolicyRevision = {
  version: string;
  hash: string;
  prevHash: string;
  actor: "HUMAN" | "SYSTEM";
  by: string;
  /** Days before the batch clock anchor. */
  daysAgo: number;
  summary: string;
  changes: string[];
};

/**
 * Every `POLICY_CHANGED` entry on the ledger, newest first.
 *
 * The history is the claim this page is really making. A configurable rule that
 * nobody can prove was configured is a rule you have to take on trust; a
 * hash-chained list saying who changed which field, when, and from what, is a
 * rule you can audit. The chain is computed by the API from the stored
 * versions — this page displays it and does not mint it.
 */
export type PolicyResponse = {
  version: string;
  pack: PolicyPack;
  revisions: PolicyRevision[];
};

/**
 * The digest a `POLICY_CHANGED` row would carry, previewed before the save.
 *
 * Byte for byte the preimage the API builds (`chainHash` in
 * `policy.service.ts`): version, the rendered changes joined by commas, and the
 * previous row's digest. That equality is the point — the Policies page shows
 * the entry a save *would* write, and a preview that would not match the row
 * actually written is the one claim an audit-adjacent page cannot afford to
 * get wrong. Rendered changes use the same `path from → to` spelling on both
 * sides (D-118).
 */
export function draftDigest(version: string, changes: PolicyChange[], prevHash: string): string {
  const rendered = changes.map((change) => `${change.path} ${change.from} → ${change.to}`);
  return hashHex(`${version}|${rendered.join(",")}|${prevHash}`, 10);
}

/** FNV-1a, widened to a hex digest. The same shape the case ledger uses. */
export function hashHex(text: string, length: number): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let out = "";
  while (out.length < length) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    out += (h >>> 0).toString(16).padStart(8, "0");
  }
  return out.slice(0, length);
}

/** The next version label, so a save reads as a revision rather than an edit. */
export function nextVersion(current: string): string {
  const n = Number(current.replace(/^v/, ""));
  return `v${Number.isFinite(n) ? n + 1 : 5}`;
}

/* ------------------------------------------------------------------ */
/* Enforcement                                                         */
/* ------------------------------------------------------------------ */

/**
 * The path an action takes to the customer (PRD 7.1).
 *
 * On this page rather than in the README because the page's whole claim is
 * that these fields are load-bearing, and that only holds if there is exactly
 * one way out of the building and it goes through them.
 */
export const ENFORCEMENT_PATH = [
  {
    step: "01",
    actor: "Planner",
    title: "Proposes an action",
    detail:
      "Picks an intervention from the playbook for this root cause, with the alternatives it rejected recorded beside it.",
  },
  {
    step: "02",
    actor: "PolicyGate",
    title: "Checks it against this pack",
    detail:
      "Every field on this page, evaluated in order. A blocked action is deferred or the case is stopped — it is never sent and reported afterwards.",
  },
  {
    step: "03",
    actor: "Executor",
    title: "Runs it, or schedules it",
    detail:
      "Only actions the gate returned as allowed reach a channel. There is no code path from Planner to Executor that skips the check.",
  },
  {
    step: "04",
    actor: "Ledger",
    title: "Records the decision either way",
    detail:
      "The check itself is an audit row, so a compliance figure can be recomputed from the ledger rather than taken from the agent's word.",
  },
] as const;
