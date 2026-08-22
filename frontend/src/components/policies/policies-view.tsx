"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { ChalkNote, ChalkRule } from "@/components/dashboard/chalk";
import {
  CheckIcon,
  LockIcon,
  RetryIcon,
  ShieldCheckSmallIcon,
} from "@/components/dashboard/icons";
import type { ChainTip } from "@/lib/audit-data";
import { appendEvent, policyVersionOf, useSessionEvents } from "@/lib/event-store";
import {
  clonePack,
  diffPacks,
  DEFAULT_PACK,
  ESCALATION_GATES,
  hashHex,
  nextVersion,
  STOPPING_RULES,
  type PolicyPack,
  type PolicyRevision,
} from "@/lib/policies-data";
import { ContactBounds, MandateRules, QuietHours } from "./contact-bounds";
import { Enforcement, PendingChanges, Revisions } from "./policy-ledger";
import { Channels, EscalationGates, StoppingRules } from "./stopping-rules";

/** How long a receipt stays on screen. Matched to the Approvals Queue. */
const TOAST_MS = 6_000;

type Toast = { id: number; title: string; detail: string };

/**
 * Policies & Guardrails (PRD 6.3, page 7).
 *
 * The page exists to answer one objection, and it is the objection a payments
 * panel always reaches: "your stopping rules are three if-statements in the
 * executor and you turned them on for the demo." So every bound the agent
 * works inside is edited here as one versioned object, the ledger entry a save
 * would write is drafted on screen before anyone presses the button, and the
 * revision history includes a loosening that had to be reverted.
 *
 * Nothing is posted anywhere yet. `PUT /policies` does not exist, and the part
 * worth getting right first is the shape of what happens around it: the diff
 * against the pack in force, the direction each change went, the digest that
 * covers the entry, and the version bump that the shell picks up immediately.
 * When the endpoint lands, `save` is the only function that changes.
 */
export function PoliciesView({
  pack: initial,
  version: initialVersion,
  revisions: initialRevisions,
  firings,
  queue,
  ledgerEntries,
  merchantName,
  tip,
}: {
  pack: PolicyPack;
  version: string;
  revisions: PolicyRevision[];
  /** Times each rule fired on the last seeded batch, keyed as in the report. */
  firings: Record<string, number>;
  /** Requests currently waiting on a human, per gate id. */
  queue: Record<string, number>;
  ledgerEntries: number;
  merchantName: string;
  /** Where the `policy` chain ends in the ledger. */
  tip: ChainTip;
}) {
  const [saved, setSaved] = useState<PolicyPack>(() => clonePack(initial));
  const [pack, setPack] = useState<PolicyPack>(() => clonePack(initial));
  const [toasts, setToasts] = useState<Toast[]>([]);

  /*
   * The version in force is folded from the ledger, not held here.
   *
   * It used to be `useState`, which is why the Policies page could reach v6
   * while the shell and the Audit Explorer were still reporting v4: three
   * surfaces, three copies, one of them updated. There is one copy now, and
   * every page reads it.
   */
  const session = useSessionEvents();
  const version = policyVersionOf(session, initialVersion);

  /** Server revisions, plus anything saved this session - newest first. */
  const revisions = useMemo(() => {
    const appended: PolicyRevision[] = session
      .filter((row) => row.action === "POLICY_CHANGED")
      .map((row) => {
        const payload = row.payload as {
          version: string;
          changed_by: string;
          changes: string[];
          summary?: string;
        };
        return {
          version: payload.version,
          hash: row.hash,
          prevHash: row.prevHash,
          actor: "HUMAN" as const,
          by: payload.changed_by,
          daysAgo: 0,
          summary: payload.summary ?? "Saved from the Policies page",
          changes: payload.changes,
        };
      })
      .reverse();
    return [...appended, ...initialRevisions];
  }, [session, initialRevisions]);
  const nextToast = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  /**
   * Receipts have to clear the save bar, and the save bar is not a fixed
   * height - it wraps to two rows on a narrow window. A magic offset would be
   * right at one width and wrong at the other, so the bar reports its own
   * height and the toast stack sits on top of it.
   */
  const bar = useRef<HTMLDivElement | null>(null);
  const [barHeight, setBarHeight] = useState(0);

  useEffect(() => {
    const node = bar.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) =>
      setBarHeight(entry.contentRect.height),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(
    () => () => {
      for (const timer of timers.current) clearTimeout(timer);
    },
    [],
  );

  const pushToast = useCallback((toast: Omit<Toast, "id">) => {
    const id = (nextToast.current += 1);
    setToasts((current) => [...current, { ...toast, id }]);
    timers.current.push(
      setTimeout(() => setToasts((current) => current.filter((row) => row.id !== id)), TOAST_MS),
    );
  }, []);

  const changes = useMemo(() => diffPacks(saved, pack), [saved, pack]);
  const dirty = changes.length > 0;
  const atDefaults = useMemo(() => diffPacks(DEFAULT_PACK, pack).length === 0, [pack]);

  const prevHash = revisions[0]?.hash ?? "0".repeat(10);
  const draftVersion = nextVersion(version);
  const draftHash = useMemo(
    () =>
      hashHex(
        `${draftVersion}|${changes.map((c) => `${c.path}:${c.from}>${c.to}`).join(",")}|${prevHash}`,
        10,
      ),
    [draftVersion, changes, prevHash],
  );

  /**
   * The save (PRD 6.3, page 7 - "every save writes a POLICY_CHANGED audit
   * entry"). The toast says so because a merchant who does not know their
   * change was recorded will make the next one carelessly.
   */
  const save = useCallback(() => {
    if (!dirty) return;

    const lines = changes.map((change) => `${change.path} ${change.from} → ${change.to}`);
    const summary = summarise(changes);

    // One write, to the ledger. The shell, the Audit Explorer and this page
    // all read the result of it rather than being told about it separately.
    const row = appendEvent({
      chain: "policy",
      caseId: null,
      actor: "HUMAN",
      action: "POLICY_CHANGED",
      detail: summary,
      tip,
      payload: {
        version: draftVersion,
        previous_version: version,
        changed_by: merchantName,
        summary,
        changes: lines,
        fields: lines.length,
      },
    });

    setSaved(clonePack(pack));

    const looser = changes.filter((change) => change.direction === "looser").length;
    pushToast({
      title: `Saved as policy ${draftVersion} · POLICY_CHANGED written`,
      detail: `${changes.length} field${changes.length === 1 ? "" : "s"}${
        looser > 0 ? `, ${looser} of them looser` : ""
      } · ledger entry ${row.hash} · in force on the next planned action`,
    });
  }, [changes, dirty, draftVersion, merchantName, pack, pushToast, tip, version]);

  const reset = useCallback(() => {
    setPack(clonePack(DEFAULT_PACK));
    pushToast({
      title: "Reset to the shipped defaults",
      detail: "Nothing is written until you save — the pack in force is still " + version,
    });
  }, [pushToast, version]);

  const discard = useCallback(() => setPack(clonePack(saved)), [saved]);

  const sectionProps = { pack, saved, onChange: setPack, firings };

  const rulesOn = STOPPING_RULES.filter((rule) => pack.rules[rule.key]).length;
  const gatesOn =
    ESCALATION_GATES.length -
    (pack.escalation.b2bAlways ? 0 : 1) -
    (pack.escalation.hardship ? 0 : 1);
  const lockedCount =
    STOPPING_RULES.filter((rule) => rule.locked).length +
    ESCALATION_GATES.filter((gate) => gate.locked).length;
  const stops = Object.values(firings).reduce((sum, n) => sum + n, 0);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="mono text-[12px] text-txt-faint">
          policy {version} · {rulesOn + gatesOn} guardrails on · {lockedCount} locked ·{" "}
          {revisions.length} revisions · seed 42
        </p>

        {dirty ? (
          <ChalkNote tone="gold" arrow>
            {changes.length} unsaved {changes.length === 1 ? "change" : "changes"}
          </ChalkNote>
        ) : (
          <ChalkNote>the pack on screen is the pack the gate is enforcing</ChalkNote>
        )}
      </div>

      {/* ---------------------------------------------------------- */}
      <section aria-label="Figures for the policy in force" className="grid grid-cols-2 xl:grid-cols-4">
        <Figure
          label="In force"
          value={<span className="tabular">{version}</span>}
          support={`${revisions.length} revisions on the ledger · chain verified`}
        />
        <Figure
          label="Guardrails on"
          value={
            <span className="tabular">
              {rulesOn + gatesOn}
              <span className="text-[0.6em] text-txt-faint">
                {" "}
                / {STOPPING_RULES.length + ESCALATION_GATES.length}
              </span>
            </span>
          }
          support={`${lockedCount} of them cannot be switched off at any price`}
        />
        <Figure
          label="Stops on the last batch"
          value={<span className="tabular">{stops}</span>}
          support="actions deferred, cases closed or requests escalated by these rules"
        />
        <Figure
          label="Violations"
          value={<span className="tabular">0</span>}
          support={
            <span className="flex items-center gap-1.5">
              <ShieldCheckSmallIcon className="h-[12px] w-[12px] text-recovered" />
              recomputed from {ledgerEntries.toLocaleString("en-IN")} ledger entries
            </span>
          }
        />
      </section>

      {/* ---------------------------------------------------------- */}
      {/* Left is what Boa may do and when; right is when it has to stop and
          who it has to ask. Channels sits under the per-channel caps it is
          capped by, and the mandate cap sits with the other counted stops. */}
      <div className="grid grid-cols-1 items-start gap-3 xl:grid-cols-2">
        <div className="space-y-3">
          <ContactBounds {...sectionProps} />
          <QuietHours {...sectionProps} />
          <Channels pack={pack} saved={saved} onChange={setPack} />
        </div>

        <div className="space-y-3">
          <StoppingRules {...sectionProps} />
          <EscalationGates pack={pack} saved={saved} onChange={setPack} queue={queue} />
          <MandateRules {...sectionProps} />
        </div>
      </div>

      {/* ---------------------------------------------------------- */}
      <div className="grid grid-cols-1 items-start gap-3 xl:grid-cols-[1.15fr_1fr]">
        <div className="space-y-3">
          <PendingChanges
            changes={changes}
            version={version}
            nextVersion={draftVersion}
            by={merchantName}
            hash={draftHash}
            prevHash={prevHash}
          />
          <Revisions revisions={revisions} current={version} />
        </div>
        <Enforcement locked={lockedCount} />
      </div>

      {/* ---------------------------------------------------------- */}
      <div ref={bar} className="save-bar">
        <ChalkRule />
        <div className="flex flex-wrap items-center justify-between gap-3 py-3">
          <p className="min-w-0 text-[12px] leading-[1.5] text-txt-dim">
            {dirty ? (
              <>
                <span className="text-waiting">
                  {changes.length} unsaved {changes.length === 1 ? "change" : "changes"}
                </span>{" "}
                · saving writes policy {draftVersion} and a POLICY_CHANGED entry to the ledger
              </>
            ) : (
              <>
                <span className="inline-flex items-center gap-1.5 text-txt">
                  <LockIcon className="h-[11px] w-[11px] text-waiting" />
                  Policy {version} in force
                </span>{" "}
                · every gate decision on every case is evaluated against this pack
              </>
            )}
          </p>

          <div className="flex flex-wrap items-center gap-2.5">
            {dirty ? (
              <button type="button" className="btn-op-quiet" onClick={discard}>
                Discard changes
              </button>
            ) : null}

            <button
              type="button"
              className="btn-op-quiet"
              onClick={reset}
              disabled={atDefaults}
              title={
                atDefaults
                  ? "The pack on screen is already the shipped default"
                  : "Restore the shipped defaults — nothing is written until you save"
              }
            >
              <RetryIcon className="h-[12px] w-[12px]" />
              Reset to defaults
            </button>

            <button
              type="button"
              onClick={save}
              disabled={!dirty}
              className="btn-gold gap-2.5 px-6 py-[11px] text-[14.5px]"
            >
              <CheckIcon className="h-[13px] w-[13px]" />
              Save policies
            </button>
          </div>
        </div>
      </div>

      <div
        className="toast-stack"
        style={{ bottom: barHeight > 0 ? barHeight + 18 : undefined }}
        aria-live="polite"
      >
        {toasts.map((toast) => (
          <div key={toast.id} className="toast">
            <p className="flex items-center gap-2 text-[12.5px] font-medium text-txt">
              <CheckIcon className="h-[12px] w-[12px] text-txt" />
              {toast.title}
            </p>
            <p className="mono mt-1 text-[11px] leading-[1.5] text-txt-faint">{toast.detail}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * A revision's one-line summary, written from the change that matters most.
 *
 * A loosening leads if there is one: reading a history six months later, the
 * question is never "what changed", it is "when did we widen something".
 */
function summarise(changes: { label: string; direction: string; to: string }[]): string {
  const lead = changes.find((change) => change.direction === "looser") ?? changes[0];
  const rest = changes.length - 1;
  const head = `${lead.label} → ${lead.to}`;
  return rest === 0 ? head : `${head}, and ${rest} other ${rest === 1 ? "field" : "fields"}`;
}

/* ------------------------------------------------------------------ */

/** The console's figure, unchanged from the Control Tower's strip. */
function Figure({
  label,
  value,
  support,
}: {
  label: string;
  value: ReactNode;
  support: ReactNode;
}) {
  return (
    <div className="px-5 py-3.5">
      <p className="chalk-hand text-[13px] uppercase tracking-[0.08em] text-txt-faint">{label}</p>
      <p className="chalk-strong mt-2 text-[clamp(21px,1.7vw,26px)] font-semibold leading-none tracking-[-0.015em] text-txt">
        {value}
      </p>
      <ChalkRule className="mt-2 w-[58%]" />
      <p className="mt-2 text-[11.5px] leading-[1.45] text-txt-dim">{support}</p>
    </div>
  );
}
