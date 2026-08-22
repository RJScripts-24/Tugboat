/**
 * The append-only ledger, assembled (PRD 6.3, page 8 · PRD 7.2 ADR-9).
 *
 * Nothing here is a second copy of anything. Every row is read out of the same
 * `getCaseDetail` the Case Detail page renders, so a digest shown on this page
 * and the digest shown beside that case's timeline are the same ten characters
 * - and the POLICY_CHANGED rows come from `lib/policies-data`, because the
 * Policies page claims the two are one chain and a claim like that has to be
 * true somewhere other than in the copy.
 *
 * Two decisions worth stating, since a payments panel will ask about both:
 *
 * 1. The chain is per case, not one global rope. A case's rows link to each
 *    other, which means one case can be verified on its own without replaying
 *    a ledger of thousands of unrelated rows - and removing a row from a case
 *    still breaks every row after it in that case. The policy pack is its own
 *    chain for the same reason.
 *
 * 2. Payloads are decision records, not archives. A row records what was
 *    decided and what it was decided from; it references large artifacts (a
 *    call transcript, a message body) by shape rather than embedding them. A
 *    ledger you cannot read at a glance is a ledger nobody audits.
 *
 * Shaped like `GET /audit` (PRD 7.5): rows, newest first, already masked.
 */

import { CLOCK_ANCHOR_MS } from "@/lib/clock";
import {
  CHANNEL_META,
  getCaseDetail,
  type AuditEntry,
  type CaseEvent,
} from "@/lib/case-detail-data";
import {
  CASE_TYPE_META,
  ROOT_CAUSE_META,
  getPipelineCases,
  type PipelineCase,
} from "@/lib/pipeline-data";
import { getRevisions } from "@/lib/policies-data";

/* ------------------------------------------------------------------ */
/* Vocabulary                                                          */
/* ------------------------------------------------------------------ */

export type LedgerActor = AuditEntry["actor"];

export const ACTOR_ORDER: LedgerActor[] = ["BOA", "POLICY", "HUMAN", "SYSTEM"];

export const ACTOR_META: Record<LedgerActor, { label: string; hex: string; note: string }> = {
  BOA: { label: "Boa", hex: "#9aeaff", note: "the agent — diagnoses, plans and executed actions" },
  POLICY: {
    label: "Policy Gate",
    hex: "#ffe886",
    note: "every check the gate ran, including the ones that blocked something",
  },
  HUMAN: {
    label: "Human",
    hex: "#fffdf8",
    note: "approvals, rejections, overrides and policy edits, each with a name",
  },
  SYSTEM: {
    label: "System",
    hex: "#f6f3ec",
    note: "webhooks, inbound messages and captured payments",
  },
};

/** A JSON payload, as it is stored. Values are already masked where masked. */
export type PayloadValue =
  | string
  | number
  | boolean
  | null
  | PayloadValue[]
  | { [key: string]: PayloadValue };

export type LedgerRow = {
  /** Stable across renders: chain plus sequence, which is unique by definition. */
  id: string;
  /** Which chain this row belongs to - a case id, or `policy`. */
  chain: string;
  seq: number;
  hash: string;
  prevHash: string;
  /**
   * Everything the digest covers except the previous hash. Shipped so the
   * browser can recompute `ledgerDigest(`${seed}|${prevHash}`)` and check it,
   * rather than being told the chain is fine.
   */
  seed: string;
  actor: LedgerActor;
  action: string;
  atMs: number;
  detail: string;
  caseId: string | null;
  /** Dotted paths inside `payload` whose value was masked before it was stored. */
  masked: string[];
  payload: PayloadValue;
};

/* ------------------------------------------------------------------ */
/* Payloads                                                            */
/* ------------------------------------------------------------------ */

/** "Attempt cap" -> "attempt_cap". Ledger keys are keys, not headings. */
function key(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

/**
 * The structured detail a timeline node carries, as ledger fields.
 *
 * The timeline already renders these rows to a human; converting them rather
 * than authoring a parallel set of payload fields is what keeps the ledger and
 * the story it is evidence for from drifting apart.
 */
function factsOf(event: CaseEvent, skip: string[] = []): Record<string, PayloadValue> {
  const body = event.body;
  if (!body || !("rows" in body) || !body.rows) return {};
  const ignore = new Set(skip);
  const out: Record<string, PayloadValue> = {};
  for (const row of body.rows) {
    const name = key(row.label);
    // The recipient is already a field of its own. The same masked number
    // twice under two names is one of them going unflagged.
    if (ignore.has(name)) continue;
    out[name] = row.value;
  }
  return out;
}

/**
 * Which fields of a row were written masked.
 *
 * Read off the values rather than declared per event kind. The mask marker is
 * in the stored string - that is what masking *is* here - so walking the
 * payload for it cannot fall out of step with what the payload actually holds,
 * which a hand-maintained list of paths eventually does.
 */
function maskedPathsIn(value: PayloadValue, path = "", out: string[] = []): string[] {
  if (typeof value === "string") {
    if (value.includes("•") && path) out.push(path);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => maskedPathsIn(item, `${path}[${i}]`, out));
    return out;
  }
  if (value !== null && typeof value === "object") {
    for (const [name, child] of Object.entries(value)) {
      maskedPathsIn(child, path ? `${path}.${name}` : name, out);
    }
  }
  return out;
}

function payloadFor(
  event: CaseEvent,
  record: PipelineCase,
  customer: { phone: string; email: string },
): PayloadValue {
  const body = event.body;
  const base: Record<string, PayloadValue> = { case_id: record.id };
  // The identifier the channel actually addressed, masked as it was stored.
  const contact = event.kind === "EMAIL_SENT" ? customer.email : customer.phone;

  switch (event.kind) {
    case "DETECTED":
      return {
        ...base,
        type: record.type,
        source: "razorpay.webhook",
        amount_paise: record.amountPaise,
        currency: "INR",
        // Masked at the boundary, before the row was written - not on the way
        // out to this screen (PRD 9.9).
        customer: { name: record.customer, contact },
        ...factsOf(event),
      };

    case "DIAGNOSED":
      return {
        ...base,
        root_cause: record.rootCause,
        confidence: record.confidence,
        method: record.method,
        signals: body?.type === "diagnosis" ? body.reasoning : [],
        ...factsOf(event),
      };

    case "PLANNED":
      return {
        ...base,
        chosen: body?.type === "plan" ? body.chosen : event.summary,
        because: body?.type === "plan" ? body.because : null,
        rejected:
          body?.type === "plan"
            ? body.rejected.map((option) => ({ option: option.option, reason: option.reason }))
            : [],
      };

    case "POLICY_CHECK":
      return {
        ...base,
        verdict: event.title.toLowerCase().includes("blocked") ? "BLOCK" : "PASS",
        policy_version: "v4",
        checks:
          body?.type === "policy"
            ? body.checks.map((check) => ({
                name: check.name,
                verdict: check.verdict.toUpperCase(),
                note: check.note,
              }))
            : [],
      };

    case "EMAIL_SENT":
    case "WHATSAPP_SENT":
      return {
        ...base,
        channel: event.kind === "EMAIL_SENT" ? "EMAIL" : "WHATSAPP",
        provider: CHANNEL_META[event.kind === "EMAIL_SENT" ? "EMAIL" : "WHATSAPP"].mode,
        recipient: contact,
        subject: body?.type === "message" ? (body.subject ?? null) : null,
        // The body is referenced by shape. A ledger that embeds every message
        // it ever sent is a ledger nobody can read (see the module note).
        body_lines: body?.type === "message" ? body.lines.length : 0,
        payment_link: body?.type === "message" ? Boolean(body.link) : false,
        ...factsOf(event, ["to", "recipient"]),
      };

    case "VOICE_CALL":
      return {
        ...base,
        channel: "VOICE",
        provider: CHANNEL_META.VOICE.mode,
        recipient: contact,
        seconds: body?.type === "voice" ? body.seconds : null,
        language: "hi-IN",
        detected_intent: body?.type === "voice" ? body.intent : null,
        transcript_turns: body?.type === "voice" ? body.transcript.length : 0,
        ...factsOf(event, ["to", "recipient"]),
      };

    case "RETRY_EXECUTED":
      return {
        ...base,
        channel: "RETRY",
        provider: CHANNEL_META.RETRY.mode,
        instrument: "•••• •••• •••• 4821",
        silent: true,
        ...factsOf(event, ["instrument"]),
      };

    case "CUSTOMER_REPLY":
      return {
        ...base,
        channel: body?.type === "reply" ? body.channel : "WHATSAPP",
        from: contact,
        sentiment: body?.type === "reply" ? body.sentiment.toUpperCase() : "NEUTRAL",
        text: body?.type === "reply" ? body.text : event.summary,
        ...factsOf(event, ["from"]),
      };

    case "PROMISE_RECORDED":
      return {
        ...base,
        amount_paise: body?.type === "promise" ? body.amountPaise : record.amountPaise,
        due: body?.type === "promise" ? body.dateLabel : null,
        days_away: body?.type === "promise" ? body.daysAway : null,
        ...factsOf(event),
      };

    case "ESCALATED":
      return { ...base, queued_to: "approvals", reason: event.summary, ...factsOf(event) };

    case "APPROVAL_DECIDED":
      return { ...base, decided_by: "Demo Merchant", outcome: event.summary, ...factsOf(event) };

    case "HALTED":
      return {
        ...base,
        rule: event.title.replace(/^Halted\s*[—-]\s*/i, ""),
        scope: "ALL_CHANNELS",
        reversible: false,
        ...factsOf(event),
      };

    case "RECOVERED":
      return {
        ...base,
        amount_paise: record.recoveredPaise || record.amountPaise,
        currency: "INR",
        attempts: record.attempts,
        ...factsOf(event),
      };

    default:
      return { ...base, detail: event.summary };
  }
}

/* ------------------------------------------------------------------ */
/* Instants                                                            */
/* ------------------------------------------------------------------ */

/**
 * A row's wall-clock instant, to the millisecond.
 *
 * Events carry an age in whole minutes, which is right for a timeline and
 * useless for a ledger - a dozen rows all stamped 14:37 have no order. The
 * sub-minute part is derived from the row's own digest, so it is stable across
 * a reload rather than being drawn fresh each render, and the pass below then
 * forces each chain to advance strictly so a row can never appear to precede
 * the row it is chained to.
 */
function instantOf(minutesAgo: number, hash: string): number {
  const jitter = parseInt(hash.slice(0, 5), 16) % 59_000;
  return CLOCK_ANCHOR_MS - minutesAgo * 60_000 - jitter;
}

/* ------------------------------------------------------------------ */
/* GET /audit                                                          */
/* ------------------------------------------------------------------ */

let cached: LedgerRow[] | null = null;

/** The whole ledger, newest first. Built once per process and handed out. */
export function getLedger(): LedgerRow[] {
  if (!cached) cached = build();
  return cached;
}

function build(): LedgerRow[] {
  const rows: LedgerRow[] = [];

  for (const record of getPipelineCases()) {
    const detail = getCaseDetail(record.id);
    if (!detail) continue;

    const chainRows: LedgerRow[] = [];
    detail.audit.forEach((entry, i) => {
      const event = detail.events[i];
      if (!event) return;
      const payload = payloadFor(event, record, detail.customer);
      chainRows.push({
        id: `${record.id}#${entry.seq}`,
        chain: record.id,
        seq: entry.seq,
        hash: entry.hash,
        prevHash: entry.prevHash,
        seed: `${record.id}|${i}|${event.kind}|${event.title}`,
        actor: entry.actor,
        action: entry.action,
        atMs: instantOf(entry.minutesAgo, entry.hash),
        detail: entry.detail,
        caseId: record.id,
        payload,
        masked: maskedPathsIn(payload),
      });
    });

    rows.push(...monotonic(chainRows));
  }

  // The policy pack's own chain. Same ledger, same digest, different subject:
  // "who changed the rules" belongs beside "what the rules stopped".
  const revisions = [...getRevisions()].reverse();
  const policyRows: LedgerRow[] = revisions.map((revision, i) => ({
    id: `policy#${i + 1}`,
    chain: "policy",
    seq: i + 1,
    hash: revision.hash,
    prevHash: revision.prevHash,
    seed: `${revision.version}|${revision.changes.join(",")}`,
    actor: revision.actor,
    action: "POLICY_CHANGED",
    atMs: instantOf(revision.daysAgo * 24 * 60, revision.hash),
    detail: revision.summary,
    caseId: null,
    masked: [],
    payload: {
      version: revision.version,
      changed_by: revision.by,
      changes: revision.changes,
      fields: revision.changes.length,
    },
  }));
  rows.push(...monotonic(policyRows));

  // Newest first, and a chain's rows never invert: a digest that covers the
  // row before it has to appear after the row before it.
  return rows.sort((a, b) =>
    b.atMs === a.atMs ? (a.chain === b.chain ? b.seq - a.seq : a.chain.localeCompare(b.chain)) : b.atMs - a.atMs,
  );
}

/** Force a chain's instants to advance with its sequence. */
function monotonic(chain: LedgerRow[]): LedgerRow[] {
  let floor = -Infinity;
  for (const row of chain) {
    if (row.atMs <= floor) row.atMs = floor + 1_000;
    floor = row.atMs;
  }
  return chain;
}

/* ------------------------------------------------------------------ */
/* Derived figures                                                     */
/* ------------------------------------------------------------------ */

export type LedgerSummary = {
  entries: number;
  chains: number;
  cases: number;
  byActor: Record<LedgerActor, number>;
  /** Distinct action types, most frequent first. */
  actions: { action: string; count: number }[];
  oldestMs: number;
  newestMs: number;
  maskedRows: number;
};

export function summarise(rows: LedgerRow[]): LedgerSummary {
  const byActor: Record<LedgerActor, number> = { BOA: 0, POLICY: 0, HUMAN: 0, SYSTEM: 0 };
  const actions = new Map<string, number>();
  const chains = new Set<string>();
  const cases = new Set<string>();
  let maskedRows = 0;
  let oldestMs = Infinity;
  let newestMs = -Infinity;

  for (const row of rows) {
    byActor[row.actor] += 1;
    actions.set(row.action, (actions.get(row.action) ?? 0) + 1);
    chains.add(row.chain);
    if (row.caseId) cases.add(row.caseId);
    if (row.masked.length > 0) maskedRows += 1;
    if (row.atMs < oldestMs) oldestMs = row.atMs;
    if (row.atMs > newestMs) newestMs = row.atMs;
  }

  return {
    entries: rows.length,
    chains: chains.size,
    cases: cases.size,
    byActor,
    actions: [...actions.entries()]
      .map(([action, count]) => ({ action, count }))
      .sort((a, b) => b.count - a.count || a.action.localeCompare(b.action)),
    oldestMs: oldestMs === Infinity ? CLOCK_ANCHOR_MS : oldestMs,
    newestMs: newestMs === -Infinity ? CLOCK_ANCHOR_MS : newestMs,
    maskedRows,
  };
}

/* ------------------------------------------------------------------ */
/* Row context                                                         */
/* ------------------------------------------------------------------ */

/** One line of context per case, so a ledger row is not just an id. */
export function getCaseIndex(): Record<string, { label: string; cause: string; stage: string }> {
  const out: Record<string, { label: string; cause: string; stage: string }> = {};
  for (const record of getPipelineCases()) {
    out[record.id] = {
      label: CASE_TYPE_META[record.type].short,
      cause: ROOT_CAUSE_META[record.rootCause].label,
      stage: record.stage,
    };
  }
  return out;
}
