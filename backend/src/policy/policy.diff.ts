import { formatClock } from "./ist-clock";
import { CHANNEL_LABELS, POLICY_CHANNELS, type PolicyPack } from "./policy-pack";

/**
 * What a save would actually write.
 *
 * Field by field rather than a deep JSON compare, because the audit entry has
 * to be readable by a person six months later: "contact.maxAttempts 4 → 6" is a
 * row somebody can review, and a before-and-after blob is not. `direction`
 * exists because the honest question about a policy change is not whether it
 * changed but which way it went — loosening a bound is the thing a compliance
 * reviewer is looking for.
 *
 * Mirrors `diffPacks` in `frontend/src/lib/policies-data.ts`; the two must
 * agree, since the page previews the diff the server then records.
 */

export type PolicyChangeDirection = "looser" | "tighter" | "changed";

export type PolicyChange = {
  /** Dotted path, exactly as the ledger payload records it. */
  path: string;
  label: string;
  from: string;
  to: string;
  direction: PolicyChangeDirection;
};

const plain = (value: number) => String(value);
const hours = (value: number) => `${value}h`;
const percent = (value: number) => `${value}%`;
const days = (value: number) => `${value}d`;
const ratio = (value: number) => value.toFixed(2);
const money = (paise: number) =>
  `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(paise / 100)}`;

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
    onIs: PolicyChangeDirection,
  ) => {
    if (a === b) return;
    const inverse = onIs === "changed" ? "changed" : onIs === "looser" ? "tighter" : "looser";
    out.push({
      path,
      label,
      from: a ? "on" : "off",
      to: b ? "on" : "off",
      direction: b ? onIs : inverse,
    });
  };

  num(
    "contact.maxAttempts",
    "Attempts per case",
    from.contact.maxAttempts,
    to.contact.maxAttempts,
    plain,
    "looser",
  );
  num(
    "contact.coolDownHours",
    "Cool-down between contacts",
    from.contact.coolDownHours,
    to.contact.coolDownHours,
    hours,
    "tighter",
  );

  for (const channel of POLICY_CHANNELS) {
    num(
      `contact.channelCaps.${channel}`,
      `${CHANNEL_LABELS[channel]} cap`,
      from.contact.channelCaps[channel],
      to.contact.channelCaps[channel],
      plain,
      "looser",
    );
  }

  num(
    "quiet.startMinutes",
    "Quiet hours start",
    from.quiet.startMinutes,
    to.quiet.startMinutes,
    formatClock,
    "looser",
  );
  num(
    "quiet.endMinutes",
    "Quiet hours end",
    from.quiet.endMinutes,
    to.quiet.endMinutes,
    formatClock,
    "tighter",
  );
  flag(
    "quiet.exemptSilentRetries",
    "Silent retries exempt",
    from.quiet.exemptSilentRetries,
    to.quiet.exemptSilentRetries,
    "looser",
  );

  flag("rules.opt_out", "Opt-out keyword halt", from.rules.opt_out, to.rules.opt_out, "tighter");
  flag(
    "rules.sentiment",
    "Negative-sentiment halt",
    from.rules.sentiment,
    to.rules.sentiment,
    "tighter",
  );
  flag("rules.deadline", "Deadline expiry", from.rules.deadline, to.rules.deadline, "tighter");
  flag(
    "rules.attempt_cap",
    "Max-attempts exhaustion",
    from.rules.attempt_cap,
    to.rules.attempt_cap,
    "tighter",
  );

  num(
    "sentimentThreshold",
    "Sentiment halt threshold",
    from.sentimentThreshold,
    to.sentimentThreshold,
    ratio,
    "looser",
  );

  num(
    "escalation.discountCapPercent",
    "Discount a human may approve",
    from.escalation.discountCapPercent,
    to.escalation.discountCapPercent,
    percent,
    "looser",
  );
  num(
    "escalation.valueThresholdPaise",
    "Escalation value threshold",
    from.escalation.valueThresholdPaise,
    to.escalation.valueThresholdPaise,
    money,
    "looser",
  );
  flag(
    "escalation.b2bAlways",
    "B2B always escalates",
    from.escalation.b2bAlways,
    to.escalation.b2bAlways,
    "tighter",
  );
  num(
    "escalation.confidenceFloor",
    "Confidence floor",
    from.escalation.confidenceFloor,
    to.escalation.confidenceFloor,
    ratio,
    "tighter",
  );
  flag(
    "escalation.hardship",
    "Hardship language gate",
    from.escalation.hardship,
    to.escalation.hardship,
    "tighter",
  );

  num(
    "mandate.maxPerCycle",
    "Re-presentations per cycle",
    from.mandate.maxPerCycle,
    to.mandate.maxPerCycle,
    plain,
    "looser",
  );
  num(
    "mandate.spacingDays",
    "Days between re-presentations",
    from.mandate.spacingDays,
    to.mandate.spacingDays,
    days,
    "tighter",
  );
  // Scheduling, not a bound: retrying after payday is neither more nor less
  // permissive than retrying the next morning, only likelier to work.
  flag(
    "mandate.alignToPayday",
    "Align retries to payday",
    from.mandate.alignToPayday,
    to.mandate.alignToPayday,
    "changed",
  );

  for (const channel of POLICY_CHANNELS) {
    flag(
      `channels.${channel}`,
      `${CHANNEL_LABELS[channel]} channel`,
      from.channels[channel],
      to.channels[channel],
      "looser",
    );
  }

  return out;
}

/** One audit-readable line per field that moved. */
export function renderChange(change: PolicyChange): string {
  return `${change.path} ${change.from} → ${change.to}`;
}

/** A one-line summary for the revision list, biased toward whichever direction dominates. */
export function summariseChanges(changes: PolicyChange[]): string {
  if (changes.length === 0) return "No change";

  const looser = changes.filter((c) => c.direction === "looser").length;
  const tighter = changes.filter((c) => c.direction === "tighter").length;
  const lead = changes[0];
  const rest = changes.length - 1;
  const tail = rest > 0 ? ` (+${rest} more)` : "";

  if (looser > 0 && tighter === 0) return `Loosened — ${lead.label}${tail}`;
  if (tighter > 0 && looser === 0) return `Tightened — ${lead.label}${tail}`;
  return `${lead.label} ${lead.from} → ${lead.to}${tail}`;
}

/** The next version label, so a save reads as a revision rather than an edit. */
export function nextVersion(current: string): string {
  const n = versionNumber(current);
  return `v${n === null ? 2 : n + 1}`;
}

/** The numeric part of a version label, or null if it is not one of ours. */
export function versionNumber(label: string): number | null {
  const n = Number(label.replace(/^v/, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * The next free label, given every label already taken.
 *
 * Derived from the highest version ever cut rather than from the one currently
 * in force. Those two are usually the same number and were assumed to be — but
 * a version stays in the table after it stops being active, so the moment they
 * diverge (a reseed re-activating an older pack, a rollback) the "next" label
 * is one that already exists, and every retry recomputes the same collision
 * (B-24).
 */
export function nextFreeVersion(existing: string[]): string {
  const highest = existing.reduce((max, label) => {
    const n = versionNumber(label);
    return n !== null && n > max ? n : max;
  }, 0);

  return `v${highest + 1}`;
}
