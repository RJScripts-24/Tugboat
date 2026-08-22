/**
 * Seeded Recovery Pipeline data (PRD 6.3, page 3).
 *
 * Shaped like `GET /cases` (PRD 7.5), so wiring the real API in later means
 * replacing the body of one function.
 *
 * The whole batch lives here - all 214 cases, not a decorative slice - because
 * the Pipeline is the page on which a panelist checks the Control Tower's
 * arithmetic. Every marginal is therefore pinned to the dashboard's own
 * figures: case counts per root cause, rupees recovered per root cause, rupees
 * still open per root cause, the funnel's stage counts, the active-case
 * breakdown, and the total at risk. Filter this page any way you like and the
 * numbers still tie out, because they were generated from the dashboard's
 * totals rather than invented beside them.
 *
 * Generation is deterministic - seeded PRNG, no clock, no `Math.random` - so
 * the server and the browser build the identical list and a given case looks
 * the same on every reload.
 */

import type { Tone } from "./dashboard-data";

const RUPEE = 100;

/* ------------------------------------------------------------------ */
/* Vocabulary                                                          */
/* ------------------------------------------------------------------ */

export type CaseType =
  | "PAYMENT_FAILED"
  | "CHECKOUT_ABANDONED"
  | "MANDATE_FAILED"
  | "INVOICE_OVERDUE";

export type RootCause =
  | "BANK_GATEWAY_DEGRADED"
  | "INSUFFICIENT_FUNDS"
  | "CUSTOMER_DISTRACTED"
  | "CARD_EXPIRED"
  | "MANDATE_REVOKED"
  | "UNKNOWN";

/** The case state machine's states (ADR-3), lower-cased for use in URLs. */
export type Stage =
  | "detected"
  | "diagnosed"
  | "intervening"
  | "waiting"
  | "escalated"
  | "promised"
  | "recovered"
  | "halted"
  | "exhausted";

export type PipelineCase = {
  id: string;
  type: CaseType;
  customer: string;
  /** Masked, always - the pipeline is a screen-share surface. */
  contact: string;
  amountPaise: number;
  rootCause: RootCause;
  /** Null while the case is still queued for diagnosis. */
  confidence: number | null;
  method: "RULES" | "LLM" | null;
  stage: Stage;
  nextAction: string;
  attempts: number;
  attemptCap: number;
  /**
   * Age of the last event, in minutes. Stored rather than a timestamp so the
   * relative label is identical on the server and the client - a `Date.now()`
   * here would be a hydration mismatch on every load.
   */
  updatedMinutesAgo: number;
  recoveredPaise: number;
};

/* ------------------------------------------------------------------ */
/* Stage metadata                                                      */
/* ------------------------------------------------------------------ */

/**
 * `group` is what the money means, not how it looks: `open` is still in flight,
 * `closed` is finished without the money. The root-cause table's "still open"
 * figure on the Control Tower is exactly the `open` group summed by cause.
 *
 * Tones repeat on purpose. A promise and an escalation are both "in flight,
 * needs watching", so both are amber rather than each earning a colour of its
 * own, and green stays reserved for recovered money.
 */
export const STAGE_META: Record<
  Stage,
  { label: string; tone: Tone; pulsing?: boolean; group: "open" | "recovered" | "closed" }
> = {
  detected: { label: "Detected", tone: "neutral", group: "open" },
  diagnosed: { label: "Diagnosed", tone: "diagnosis", group: "open" },
  intervening: { label: "Intervening", tone: "waiting", pulsing: true, group: "open" },
  waiting: { label: "Waiting", tone: "neutral", group: "open" },
  escalated: { label: "Escalated", tone: "waiting", group: "open" },
  promised: { label: "Committed", tone: "waiting", group: "open" },
  recovered: { label: "Recovered", tone: "recovered", group: "recovered" },
  halted: { label: "Halted", tone: "halted", group: "closed" },
  exhausted: { label: "Exhausted", tone: "neutral", group: "closed" },
};

/** Filter order: in flight first, outcomes last - the order an operator triages. */
export const STAGE_ORDER: Stage[] = [
  "detected",
  "diagnosed",
  "intervening",
  "waiting",
  "escalated",
  "promised",
  "recovered",
  "halted",
  "exhausted",
];

export const CASE_TYPE_META: Record<CaseType, { label: string; short: string }> = {
  PAYMENT_FAILED: { label: "Payment failed", short: "Payment" },
  CHECKOUT_ABANDONED: { label: "Checkout abandoned", short: "Checkout" },
  MANDATE_FAILED: { label: "Mandate failed", short: "Mandate" },
  INVOICE_OVERDUE: { label: "Invoice overdue", short: "Invoice" },
};

export const CASE_TYPE_ORDER: CaseType[] = [
  "PAYMENT_FAILED",
  "CHECKOUT_ABANDONED",
  "MANDATE_FAILED",
  "INVOICE_OVERDUE",
];

export const ROOT_CAUSE_META: Record<RootCause, { label: string; tone: Tone }> = {
  BANK_GATEWAY_DEGRADED: { label: "Bank gateway degraded", tone: "diagnosis" },
  INSUFFICIENT_FUNDS: { label: "Insufficient funds", tone: "waiting" },
  CUSTOMER_DISTRACTED: { label: "Customer distracted", tone: "neutral" },
  CARD_EXPIRED: { label: "Card expired", tone: "diagnosis" },
  MANDATE_REVOKED: { label: "Mandate revoked", tone: "halted" },
  UNKNOWN: { label: "Unknown", tone: "neutral" },
};

export const ROOT_CAUSE_ORDER: RootCause[] = [
  "BANK_GATEWAY_DEGRADED",
  "INSUFFICIENT_FUNDS",
  "CUSTOMER_DISTRACTED",
  "CARD_EXPIRED",
  "MANDATE_REVOKED",
  "UNKNOWN",
];

/** Bands, not two number inputs: nobody types rupee bounds while triaging. */
export const AMOUNT_BANDS = [
  { key: "lt1k", label: "Under ₹1,000", min: 0, max: 1_000 * RUPEE },
  { key: "1k5k", label: "₹1,000 – ₹5,000", min: 1_000 * RUPEE, max: 5_000 * RUPEE },
  { key: "5k25k", label: "₹5,000 – ₹25,000", min: 5_000 * RUPEE, max: 25_000 * RUPEE },
  { key: "gt25k", label: "Over ₹25,000", min: 25_000 * RUPEE, max: Number.MAX_SAFE_INTEGER },
] as const;

export type AmountBandKey = (typeof AMOUNT_BANDS)[number]["key"];

/* ------------------------------------------------------------------ */
/* The plan                                                            */
/* ------------------------------------------------------------------ */

/**
 * One row per root cause, and every column of it is a figure the Control Tower
 * already publishes.
 *
 *  - `types` sums down each column to the batch mix in PRD 8 (86 payment,
 *    53 checkout, 43 mandate, 32 invoice) and across each row to that cause's
 *    case count in `getRecoveryByRootCause`.
 *  - `stages` sums down to the funnel and the active-case breakdown in
 *    `getKpis`: 24 intervening, 18 waiting, 9 diagnosed, 7 escalated,
 *    5 committed, 96 recovered, and the 6 cases the funnel shows as detected
 *    but not yet diagnosed.
 *  - `budgetRupees.recovered` and `.open` are that cause's two money columns in
 *    the root-cause table, verbatim. `.closed` is what is left of the 4,12,000
 *    at risk once those are taken out - the money this batch honestly did not
 *    get back.
 *
 * Hand-fixed rather than sampled: these are simultaneous constraints, and a
 * sampler that "usually" satisfies them is a sampler that eventually embarrasses
 * you on stage.
 */
type CausePlan = {
  cause: RootCause;
  types: Partial<Record<CaseType, number>>;
  stages: Partial<Record<Stage, number>>;
  budgetRupees: { recovered: number; open: number; closed: number };
};

const CAUSE_PLAN: CausePlan[] = [
  {
    cause: "BANK_GATEWAY_DEGRADED",
    types: { PAYMENT_FAILED: 45, CHECKOUT_ABANDONED: 17, MANDATE_FAILED: 5, INVOICE_OVERDUE: 4 },
    stages: {
      recovered: 45,
      detected: 2,
      diagnosed: 3,
      intervening: 5,
      waiting: 1,
      halted: 3,
      exhausted: 12,
    },
    budgetRupees: { recovered: 68_400, open: 14_200, closed: 14_000 },
  },
  {
    cause: "INSUFFICIENT_FUNDS",
    types: { PAYMENT_FAILED: 18, CHECKOUT_ABANDONED: 7, MANDATE_FAILED: 14, INVOICE_OVERDUE: 8 },
    stages: {
      recovered: 21,
      detected: 2,
      diagnosed: 2,
      intervening: 7,
      waiting: 6,
      promised: 1,
      halted: 2,
      exhausted: 6,
    },
    budgetRupees: { recovered: 42_100, open: 38_600, closed: 8_600 },
  },
  {
    cause: "CUSTOMER_DISTRACTED",
    types: { PAYMENT_FAILED: 4, CHECKOUT_ABANDONED: 21, INVOICE_OVERDUE: 14 },
    stages: {
      recovered: 12,
      detected: 1,
      diagnosed: 2,
      intervening: 6,
      waiting: 7,
      escalated: 2,
      promised: 1,
      halted: 4,
      exhausted: 4,
    },
    budgetRupees: { recovered: 31_600, open: 44_800, closed: 33_500 },
  },
  {
    cause: "CARD_EXPIRED",
    types: { PAYMENT_FAILED: 14, CHECKOUT_ABANDONED: 6, MANDATE_FAILED: 4, INVOICE_OVERDUE: 4 },
    stages: {
      recovered: 11,
      detected: 1,
      diagnosed: 1,
      intervening: 3,
      waiting: 2,
      halted: 3,
      exhausted: 7,
    },
    budgetRupees: { recovered: 28_900, open: 12_400, closed: 18_000 },
  },
  {
    cause: "MANDATE_REVOKED",
    types: { MANDATE_FAILED: 19 },
    stages: {
      recovered: 7,
      diagnosed: 1,
      intervening: 3,
      waiting: 2,
      escalated: 1,
      promised: 3,
      exhausted: 2,
    },
    budgetRupees: { recovered: 13_300, open: 27_900, closed: 1_600 },
  },
  {
    // Never diagnosed above the 0.60 confidence threshold, so never guessed at:
    // every one of these is escalated, halted or closed out (ADR-5).
    cause: "UNKNOWN",
    types: { PAYMENT_FAILED: 5, CHECKOUT_ABANDONED: 2, MANDATE_FAILED: 1, INVOICE_OVERDUE: 2 },
    stages: { escalated: 4, halted: 2, exhausted: 4 },
    budgetRupees: { recovered: 0, open: 8_900, closed: 5_200 },
  },
];

/**
 * The ten cases the Control Tower names by id.
 *
 * Pinned verbatim so "Open pipeline" lands on the same rows a panelist just
 * read on the dashboard - a list that quietly renamed them would undo the point
 * of the page. Each anchor's amount is deducted from its bucket's budget before
 * the rest is distributed, so pinning them costs nothing in accuracy.
 */
type Anchor = {
  id: string;
  cause: RootCause;
  type: CaseType;
  stage: Stage;
  customer: string;
  contact: string;
  rupees: number;
  confidence: number | null;
  method: "RULES" | "LLM" | null;
  nextAction: string;
  attempts: number;
  attemptCap: number;
  updatedMinutesAgo: number;
};

const ANCHORS: Anchor[] = [
  {
    id: "C-1195",
    cause: "CARD_EXPIRED",
    type: "PAYMENT_FAILED",
    stage: "intervening",
    customer: "Acme Labs",
    contact: "98•••••210",
    rupees: 4_800,
    confidence: 0.71,
    method: "LLM",
    nextAction: "WhatsApp · 09:00",
    attempts: 1,
    attemptCap: 4,
    updatedMinutesAgo: 3,
  },
  {
    id: "C-1187",
    cause: "BANK_GATEWAY_DEGRADED",
    type: "PAYMENT_FAILED",
    stage: "recovered",
    customer: "Nova Foods",
    contact: "97•••••441",
    rupees: 2_340,
    confidence: 0.93,
    method: "RULES",
    nextAction: "—",
    attempts: 1,
    attemptCap: 4,
    updatedMinutesAgo: 12,
  },
  {
    id: "C-1174",
    cause: "CUSTOMER_DISTRACTED",
    type: "CHECKOUT_ABANDONED",
    stage: "waiting",
    customer: "Orbit Retail",
    contact: "90•••••118",
    rupees: 8_200,
    confidence: 0.68,
    method: "LLM",
    nextAction: "Email · tomorrow 10:00",
    attempts: 2,
    attemptCap: 4,
    updatedMinutesAgo: 5,
  },
  {
    id: "C-1163",
    cause: "CUSTOMER_DISTRACTED",
    type: "INVOICE_OVERDUE",
    stage: "halted",
    customer: "Kettle & Co",
    contact: "ops@•••••.in",
    rupees: 26_500,
    confidence: 0.74,
    method: "LLM",
    nextAction: "Blocked · opt-out",
    attempts: 2,
    attemptCap: 4,
    updatedMinutesAgo: 18,
  },
  {
    id: "C-1156",
    cause: "INSUFFICIENT_FUNDS",
    type: "MANDATE_FAILED",
    stage: "intervening",
    customer: "Sunrise Dairy",
    contact: "96•••••077",
    rupees: 1_499,
    confidence: 0.96,
    method: "RULES",
    nextAction: "Re-present 2/3 · 24 Aug",
    attempts: 1,
    attemptCap: 3,
    updatedMinutesAgo: 4,
  },
  {
    id: "C-1149",
    cause: "CUSTOMER_DISTRACTED",
    type: "CHECKOUT_ABANDONED",
    stage: "escalated",
    customer: "Beam Interiors",
    contact: "88•••••905",
    rupees: 2_400,
    confidence: 0.62,
    method: "LLM",
    nextAction: "Awaiting approval · 12% discount",
    attempts: 2,
    attemptCap: 4,
    updatedMinutesAgo: 22,
  },
  {
    id: "C-1102",
    cause: "CUSTOMER_DISTRACTED",
    type: "INVOICE_OVERDUE",
    stage: "promised",
    customer: "Harbour Textiles",
    contact: "93•••••562",
    rupees: 18_400,
    confidence: 0.81,
    method: "LLM",
    nextAction: "Promise check-in · 24 Aug",
    attempts: 3,
    attemptCap: 4,
    updatedMinutesAgo: 41,
  },
  {
    id: "C-1088",
    cause: "MANDATE_REVOKED",
    type: "MANDATE_FAILED",
    stage: "exhausted",
    customer: "Peak Fitness",
    contact: "99•••••334",
    rupees: 999,
    confidence: 0.99,
    method: "RULES",
    nextAction: "—",
    attempts: 3,
    attemptCap: 3,
    updatedMinutesAgo: 190,
  },
  {
    id: "C-1071",
    cause: "INSUFFICIENT_FUNDS",
    type: "PAYMENT_FAILED",
    stage: "recovered",
    customer: "Lumen Studio",
    contact: "70•••••826",
    rupees: 12_050,
    confidence: 0.91,
    method: "RULES",
    nextAction: "—",
    attempts: 3,
    attemptCap: 4,
    updatedMinutesAgo: 320,
  },
  {
    id: "C-1064",
    cause: "UNKNOWN",
    type: "PAYMENT_FAILED",
    stage: "escalated",
    customer: "Tiller Group",
    contact: "81•••••390",
    rupees: 7_600,
    confidence: 0.41,
    method: "LLM",
    nextAction: "Escalated · confidence < 0.60",
    attempts: 0,
    attemptCap: 4,
    updatedMinutesAgo: 460,
  },
];

/* ------------------------------------------------------------------ */
/* Deterministic helpers                                               */
/* ------------------------------------------------------------------ */

/** mulberry32 - small, fast, and identical in Node and every browser. */
function rngFrom(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Fisher-Yates, driven by the caller's stream so the whole run stays seeded. */
function shuffle<T>(items: T[], rand: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function flatten<K extends string>(counts: Partial<Record<K, number>>): K[] {
  const out: K[] = [];
  for (const key of Object.keys(counts) as K[]) {
    for (let i = 0; i < (counts[key] ?? 0); i += 1) out.push(key);
  }
  return out;
}

/**
 * Split `total` across `weights` so the parts are integers, none is below
 * `floor`, and - the point of the exercise - they sum to exactly `total`.
 * Rounding error is pushed onto the largest parts, where a rupee either way is
 * invisible, rather than being allowed to leak out of the batch.
 */
function distribute(total: number, weights: number[], floor: number): number[] {
  if (weights.length === 0) return [];
  const sum = weights.reduce((acc, w) => acc + w, 0) || 1;
  const parts = weights.map((w) => Math.max(floor, Math.round((total * w) / sum)));

  const order = parts
    .map((value, index) => ({ value, index }))
    .sort((a, b) => b.value - a.value)
    .map((entry) => entry.index);

  let drift = total - parts.reduce((acc, v) => acc + v, 0);
  for (let step = 0; drift !== 0 && step < parts.length * 400; step += 1) {
    const index = order[step % order.length];
    if (drift > 0) {
      parts[index] += 1;
      drift -= 1;
    } else if (parts[index] > floor) {
      parts[index] -= 1;
      drift += 1;
    }
  }
  return parts;
}

/* ------------------------------------------------------------------ */
/* Names and contacts                                                  */
/* ------------------------------------------------------------------ */

const BRAND_HEADS = [
  "Saffron", "Indigo", "Banyan", "Monsoon", "Deccan", "Konkan", "Marigold", "Copper",
  "Cinder", "Lantern", "Anchor", "Mistral", "Tamarind", "Neem", "Sandal", "Basalt",
  "Quartz", "Verdant", "Ochre", "Vetiver", "Kadam", "Palash", "Amaltas", "Chinar",
  "Zephyr", "Kestrel", "Godavari", "Kaveri", "Nilgiri", "Aravalli", "Satpura", "Vindhya",
  "Bhima", "Chandan", "Pipal", "Kohl", "Kalinga", "Malabar", "Coromandel", "Rann",
  "Sarai", "Trellis", "Vermilion", "Windlass", "Yardarm", "Bellweather", "Coriander", "Jute",
];

const BRAND_TAILS = [
  "Labs", "Foods", "Retail", "& Co", "Dairy", "Interiors", "Textiles", "Fitness",
  "Studio", "Group", "Traders", "Exports", "Logistics", "Kitchens", "Motors", "Prints",
  "Organics", "Ceramics", "Apparel", "Metals", "Analytics", "Systems", "Ventures", "Works",
  "Supply", "Freight", "Agro", "Nursery", "Bakers", "Optics",
];

const FIRST_NAMES = [
  "Aarav", "Isha", "Rohan", "Meera", "Kabir", "Ananya", "Devansh", "Prisha",
  "Vikram", "Nandini", "Arjun", "Tara", "Ishaan", "Kavya", "Rehan", "Sana",
  "Yash", "Diya", "Aditya", "Riya", "Nikhil", "Aisha", "Siddharth", "Pooja",
  "Manav", "Lata", "Zoya", "Harsh", "Neel", "Anika", "Farhan", "Gauri",
  "Imran", "Jaya", "Karthik", "Leela", "Mohit", "Nisha", "Omkar", "Payal",
];

const LAST_NAMES = [
  "Sharma", "Iyer", "Nair", "Reddy", "Banerjee", "Kulkarni", "Chatterjee", "Menon",
  "Deshpande", "Gowda", "Bhatt", "Sethi", "Chauhan", "Pillai", "Rao", "Joshi",
  "Verma", "Mehta", "Kaur", "Dutta", "Ghosh", "Naidu", "Patil", "Saxena",
  "Trivedi", "Bose", "Chopra", "Fernandes", "Hegde", "Jain", "Khanna", "Lal",
  "Mishra", "Prabhu", "Shetty",
];

function makeName(useBusiness: boolean, rand: () => number, taken: Set<string>): string {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const name = useBusiness
      ? `${BRAND_HEADS[Math.floor(rand() * BRAND_HEADS.length)]} ${
          BRAND_TAILS[Math.floor(rand() * BRAND_TAILS.length)]
        }`
      : `${FIRST_NAMES[Math.floor(rand() * FIRST_NAMES.length)]} ${
          LAST_NAMES[Math.floor(rand() * LAST_NAMES.length)]
        }`;
    if (!taken.has(name)) {
      taken.add(name);
      return name;
    }
  }
  // Two customers really can share a name; a suffix is honest, a crash is not.
  const fallback = `${BRAND_HEADS[Math.floor(rand() * BRAND_HEADS.length)]} ${taken.size}`;
  taken.add(fallback);
  return fallback;
}

/** Masked at the source, not in the view - unmasked contacts never exist here. */
function makeContact(type: CaseType, rand: () => number): string {
  if (type === "INVOICE_OVERDUE" && rand() < 0.55) {
    const box = ["ops", "accounts", "finance", "billing", "ap"][Math.floor(rand() * 5)];
    return `${box}@•••••.in`;
  }
  const lead = ["70", "81", "88", "90", "93", "96", "97", "98", "99"][Math.floor(rand() * 9)];
  const tail = String(Math.floor(rand() * 1000)).padStart(3, "0");
  return `${lead}•••••${tail}`;
}

/* ------------------------------------------------------------------ */
/* Diagnosis, plan and clock                                           */
/* ------------------------------------------------------------------ */

/**
 * Which lane diagnosed the case (ADR-5).
 *
 * Known gateway error codes resolve in the rules table and cost nothing; the
 * LLM is invoked only where the signals genuinely conflict, which is roughly a
 * seventh of the deterministic causes and all of the ambiguous ones. The
 * dominant lane per cause matches the method column on the Control Tower's
 * root-cause table.
 */
function methodFor(cause: RootCause, rand: () => number): "RULES" | "LLM" {
  if (cause === "UNKNOWN" || cause === "CUSTOMER_DISTRACTED") return "LLM";
  return rand() < 0.14 ? "LLM" : "RULES";
}

function confidenceFor(
  cause: RootCause,
  method: "RULES" | "LLM",
  rand: () => number,
): number {
  // Below 0.60 the agent escalates instead of guessing - so UNKNOWN sits there
  // by construction, and nothing else is allowed to.
  if (cause === "UNKNOWN") return round2(0.31 + rand() * 0.27);
  if (method === "RULES") return round2(0.88 + rand() * 0.11);
  return round2(0.63 + rand() * 0.25);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

const DAYS = ["23 Aug", "24 Aug", "25 Aug", "26 Aug", "27 Aug"];

/**
 * What the agent does next, written the way the playbooks (PRD 7.6) decide it -
 * root cause first, then the bound that applies. A next action that reads
 * "follow up" tells an operator nothing; one that names the channel, the clock
 * and the attempt is the bounded workflow made legible.
 */
function nextActionFor(
  stage: Stage,
  cause: RootCause,
  type: CaseType,
  attempts: number,
  cap: number,
  rand: () => number,
): string {
  const day = DAYS[Math.floor(rand() * DAYS.length)];

  switch (stage) {
    case "detected":
      return "Diagnosis queued";
    case "diagnosed":
      return cause === "BANK_GATEWAY_DEGRADED"
        ? "Hold for gateway recovery"
        : "Planning intervention";
    case "intervening":
      if (cause === "BANK_GATEWAY_DEGRADED") {
        return `Silent retry · ${["16:40", "17:10", "18:25", "20:05"][Math.floor(rand() * 4)]}`;
      }
      if (type === "MANDATE_FAILED") return `Re-present ${attempts + 1}/${cap} · ${day}`;
      if (cause === "CARD_EXPIRED") return "Update-card link · WhatsApp";
      if (cause === "INSUFFICIENT_FUNDS") return "Fund-account nudge · 10:00";
      return `WhatsApp nudge · ${attempts + 1}/${cap}`;
    case "waiting":
      return rand() < 0.5
        ? `Follow-up · ${day} 10:00`
        : `Cool-down · ${8 + Math.floor(rand() * 12)}h left`;
    case "escalated":
      if (cause === "UNKNOWN") return "Escalated · confidence < 0.60";
      if (type === "INVOICE_OVERDUE") return "Escalated · high-value B2B";
      return rand() < 0.5 ? "Awaiting approval · discount" : "Escalated · hardship language";
    case "promised":
      return `Promise check-in · ${day}`;
    case "halted":
      return rand() < 0.6 ? "Blocked · opt-out" : "Halted · negative sentiment";
    default:
      return "—";
  }
}

/** Attempts used against the cap, consistent with where the case has got to. */
function attemptsFor(stage: Stage, cap: number, rand: () => number): number {
  switch (stage) {
    case "detected":
    case "diagnosed":
      return 0;
    case "exhausted":
      return cap;
    case "intervening":
      return 1 + Math.floor(rand() * Math.max(1, cap - 2));
    case "waiting":
      return 1 + Math.floor(rand() * Math.max(1, cap - 1));
    case "escalated":
      return Math.floor(rand() * cap);
    case "promised":
      return 1 + Math.floor(rand() * Math.max(1, cap - 1));
    case "halted":
      return 1 + Math.floor(rand() * Math.max(1, cap - 1));
    default:
      // Recovered: the cheapest win possible, which is usually the first one.
      return 1 + Math.floor(rand() * Math.max(1, cap - 2));
  }
}

/** Terminal cases stop generating events, so they drift to the bottom by age. */
function ageFor(stage: Stage, rand: () => number): number {
  const spans: Record<Stage, [number, number]> = {
    intervening: [1, 90],
    detected: [1, 45],
    diagnosed: [2, 120],
    waiting: [30, 900],
    escalated: [20, 700],
    promised: [40, 1_100],
    recovered: [15, 3_400],
    halted: [90, 3_000],
    exhausted: [240, 4_300],
  };
  const [low, high] = spans[stage];
  return Math.round(low + rand() * (high - low));
}

/* ------------------------------------------------------------------ */
/* GET /cases                                                          */
/* ------------------------------------------------------------------ */

let cached: PipelineCase[] | null = null;

/** The seeded batch, built once per process and then handed out by reference. */
export function getPipelineCases(): PipelineCase[] {
  if (!cached) cached = buildBatch();
  return cached;
}

function buildBatch(): PipelineCase[] {
  const draft: (Omit<PipelineCase, "id"> & { pinnedId?: string })[] = [];
  const takenNames = new Set(ANCHORS.map((a) => a.customer));

  for (const plan of CAUSE_PLAN) {
    const rand = rngFrom(hash(`tugboat/seed-42/${plan.cause}`));
    const anchors = ANCHORS.filter((a) => a.cause === plan.cause);

    // Anchors occupy a real slot each, so the marginals stay exact.
    const types = flatten<CaseType>(plan.types);
    const stages = flatten<Stage>(plan.stages);
    for (const anchor of anchors) {
      types.splice(types.indexOf(anchor.type), 1);
      stages.splice(stages.indexOf(anchor.stage), 1);
    }

    // Type and stage are drawn independently: the plan already fixes how many
    // of each this cause gets, and nothing in the product claims that (say)
    // invoices halt more often than checkouts within one root cause.
    const shuffledStages = shuffle(stages, rngFrom(hash(`${plan.cause}/stages`)));
    const pairs = shuffle(types, rand).map((type, i) => ({ type, stage: shuffledStages[i] }));

    // Amounts are distributed inside each money group, because it is the group
    // totals - recovered, still open, closed out - that have to match the
    // dashboard, not any individual case.
    const TYPE_WEIGHT: Record<CaseType, number> = {
      PAYMENT_FAILED: 1,
      CHECKOUT_ABANDONED: 0.95,
      MANDATE_FAILED: 0.34,
      INVOICE_OVERDUE: 3.4,
    };

    for (const group of ["recovered", "open", "closed"] as const) {
      const members = pairs.filter((p) => STAGE_META[p.stage].group === group);
      if (members.length === 0) continue;

      const spentByAnchors = anchors
        .filter((a) => STAGE_META[a.stage].group === group)
        .reduce((sum, a) => sum + a.rupees, 0);

      const rupees = distribute(
        plan.budgetRupees[group] - spentByAnchors,
        members.map((m) => TYPE_WEIGHT[m.type] * (0.62 + rand() * 0.9)),
        149,
      );

      members.forEach((member, i) => {
        const cap = member.type === "MANDATE_FAILED" ? 3 : 4;
        const undiagnosed = member.stage === "detected";
        const method = methodFor(plan.cause, rand);
        const attempts = attemptsFor(member.stage, cap, rand);

        draft.push({
          type: member.type,
          customer: makeName(
            member.type === "INVOICE_OVERDUE" ||
              (member.type !== "MANDATE_FAILED" && rand() < 0.45),
            rand,
            takenNames,
          ),
          contact: makeContact(member.type, rand),
          amountPaise: rupees[i] * RUPEE,
          rootCause: plan.cause,
          confidence: undiagnosed ? null : confidenceFor(plan.cause, method, rand),
          method: undiagnosed ? null : method,
          stage: member.stage,
          nextAction: nextActionFor(member.stage, plan.cause, member.type, attempts, cap, rand),
          attempts,
          attemptCap: cap,
          updatedMinutesAgo: ageFor(member.stage, rand),
          recoveredPaise: member.stage === "recovered" ? rupees[i] * RUPEE : 0,
        });
      });
    }

    for (const anchor of anchors) {
      draft.push({
        pinnedId: anchor.id,
        type: anchor.type,
        customer: anchor.customer,
        contact: anchor.contact,
        amountPaise: anchor.rupees * RUPEE,
        rootCause: anchor.cause,
        confidence: anchor.confidence,
        method: anchor.method,
        stage: anchor.stage,
        nextAction: anchor.nextAction,
        attempts: anchor.attempts,
        attemptCap: anchor.attemptCap,
        updatedMinutesAgo: anchor.updatedMinutesAgo,
        recoveredPaise: anchor.stage === "recovered" ? anchor.rupees * RUPEE : 0,
      });
    }
  }

  // Ids run with the clock: the oldest case in the batch is C-1001 and the
  // newest is C-1214, which is what makes the anchors' numbers land where a
  // reader expects them to.
  const pinned = new Set(ANCHORS.map((a) => a.id));
  const pool: string[] = [];
  for (let n = 1; n <= 214; n += 1) {
    const id = `C-${1000 + n}`;
    if (!pinned.has(id)) pool.push(id);
  }

  const byAge = draft
    .map((row, index) => ({ row, index }))
    .sort((a, b) => b.row.updatedMinutesAgo - a.row.updatedMinutesAgo || a.index - b.index);

  let next = 0;
  const cases: PipelineCase[] = byAge.map(({ row }) => {
    const { pinnedId, ...rest } = row;
    return { id: pinnedId ?? pool[next++], ...rest };
  });

  // Newest first: the default reading order of an operational list.
  return cases.sort((a, b) => a.updatedMinutesAgo - b.updatedMinutesAgo);
}

/* ------------------------------------------------------------------ */
/* Customer shape                                                      */
/* ------------------------------------------------------------------ */

/**
 * Two facts about the person behind a case that more than one page needs, and
 * which therefore cannot be drawn from any page's own random stream.
 *
 * The Case Detail card says "hi-IN · Hinglish" and the Approvals Queue shows
 * the draft that would actually be sent. If those two derived the language
 * separately, the card and the message in front of the approver could disagree
 * about which language the customer reads - so both call these.
 */
export function segmentOf(record: PipelineCase): "B2C" | "B2B" {
  const businessLike = record.contact.includes("@") || record.customer.includes("&");
  return record.type === "INVOICE_OVERDUE" || businessLike ? "B2B" : "B2C";
}

/**
 * Code-mixed or English, keyed by the case id alone.
 *
 * The rates match the batch's own mix - most consumers in this merchant's book
 * read Hinglish, most businesses correspond in English - and being a pure
 * function of the id means the answer survives any reordering of the
 * generators that consume it.
 */
export function prefersHinglish(record: PipelineCase): boolean {
  const threshold = segmentOf(record) === "B2C" ? 68 : 34;
  return hash(`${record.id}/language`) % 100 < threshold;
}

/* ------------------------------------------------------------------ */
/* Presentation helpers                                                */
/* ------------------------------------------------------------------ */

/** Relative, coarse, and computed from a stored offset so SSR can render it. */
export function formatAge(minutes: number): string {
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1_440) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1_440)}d ago`;
}
