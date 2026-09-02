"use client";

import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react";

import { ChalkNote, ChalkRule } from "@/components/dashboard/chalk";
import {
  CheckIcon,
  LockIcon,
  RetryIcon,
  ShieldCheckSmallIcon,
} from "@/components/dashboard/icons";
import { savePolicies } from "@/lib/actions";
import {
  clonePack,
  diffPacks,
  DEFAULT_PACK,
  ESCALATION_GATES,
  draftDigest,
  nextVersion,
  STOPPING_RULES,
  type PolicyPack,
  type PolicyRevision,
} from "@/lib/policies-data";
import type { ComplianceBlock } from "@/lib/simulation-data";
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
 * A save is `PUT /policies`, and everything around it is the server's answer
 * rather than this page's guess. The diff on screen before you press the button
 * is a preview computed by `diffPacks` - the same function the API runs, which
 * is why the preview and the recorded change agree - and the version number,
 * the digest and the `POLICY_CHANGED` ledger row all come back from the write.
 *
 * The version in force used to be folded from a browser-side event log, because
 * three surfaces held three copies of it and the Policies page could reach v6
 * while the shell and the Audit Explorer still said v4. There is one copy now:
 * the pack row in Postgres, which every page reads and the PolicyGate checks
 * against on every action.
 */
export function PoliciesView({
  pack: initial,
  version: initialVersion,
  revisions: initialRevisions,
  firings,
  queue,
  ledgerEntries,
  compliance,
  seed,
  merchantName,
}: {
  pack: PolicyPack;
  version: string;
  revisions: PolicyRevision[];
  /** Times each rule fired on the last seeded batch, keyed as in the report. */
  firings: Record<string, number>;
  /** Requests currently waiting on a human, per gate id. */
  queue: Record<string, number>;
  ledgerEntries: number;
  /** The promoted run's compliance block, or null when nothing is promoted. */
  compliance: ComplianceBlock | null;
  /** The promoted run's seed. Null when this data did not come from a run. */
  seed: number | null;
  merchantName: string;
}) {
  const [saved, setSaved] = useState<PolicyPack>(() => clonePack(initial));
  const [pack, setPack] = useState<PolicyPack>(() => clonePack(initial));
  const [toasts, setToasts] = useState<Toast[]>([]);

  /*
   * The version in force, and the revisions behind it, come from the server.
   *
   * This used to be folded from a browser-side event log for a reason that
   * still holds - a version kept in three `useState`s is a version three pages
   * disagree about - and the fold is simply not needed once there is one row to
   * read. `savePolicies` revalidates this page, so the number below changes
   * because the pack changed, not because a component was told to change it.
   */
  const version = initialVersion;
  const revisions = initialRevisions;

  const router = useRouter();
  const [saving, startTransition] = useTransition();

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
  // The digest the API would write, built from the API's own preimage (D-118).
  const draftHash = useMemo(
    () => draftDigest(draftVersion, changes, prevHash),
    [draftVersion, changes, prevHash],
  );

  /**
   * The save (PRD 6.3, page 7 - "every save writes a POLICY_CHANGED audit
   * entry"). The toast says so because a merchant who does not know their
   * change was recorded will make the next one carelessly.
   *
   * The version and the digest in the receipt are the ones the API cut, not the
   * ones drafted above: a draft digest is a preview of a row that has not been
   * written, and printing it as though it had been would be the one claim on
   * this page that the ledger could not back up.
   */
  const save = useCallback(() => {
    if (!dirty || saving) return;

    const attempted = changes.length;
    const looser = changes.filter((change) => change.direction === "looser").length;
    const submitted = clonePack(pack);

    startTransition(async () => {
      const result = await savePolicies(submitted);

      if (!result.ok) {
        pushToast({
          title: "The pack was not saved",
          detail: result.error,
        });
        return;
      }

      // The server's pack, not the one that was sent: `opt_out` cannot be
      // disabled and a rejected field comes back as it stands (D-49), so the
      // baseline the diff runs against has to be what was actually stored.
      setSaved(clonePack(result.data.pack));
      setPack(clonePack(result.data.pack));
      router.refresh();

      pushToast({
        title: `Saved as policy ${result.data.version} \u00b7 POLICY_CHANGED written`,
        detail: `${attempted} field${attempted === 1 ? "" : "s"}${
          looser > 0 ? `, ${looser} of them looser` : ""
        } \u00b7 in force on the next planned action`,
      });
    });
  }, [changes, dirty, pack, pushToast, router, saving]);

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
  // A compliance assertion that did not hold is the definition of a violation
  // here; the report evaluates each one against the run's own ledger rows.
  const failedAssertions = compliance
    ? compliance.assertions.filter((assertion) => !assertion.held).length
    : 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="mono text-[12px] text-txt-faint">
          policy {version} · {rulesOn + gatesOn} guardrails on · {lockedCount} locked ·{" "}
          {revisions.length} revisions{seed !== null ? ` · seed ${seed}` : ""}
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
        {/* Was the literal `0`, captioned with the live ledger's row count — a
            verdict nobody computed, over a denominator that measured nothing.
            The promoted run's compliance block is the only place this product
            actually evaluates the claims, so it is the only place the figure
            can honestly come from. */}
        <Figure
          label="Violations"
          value={<span className="tabular">{compliance ? failedAssertions : "—"}</span>}
          support={
            compliance ? (
              <span className="flex items-center gap-1.5">
                {failedAssertions === 0 ? (
                  <ShieldCheckSmallIcon className="h-[12px] w-[12px] text-recovered" />
                ) : null}
                across {compliance.assertions.length} checks over the promoted run&rsquo;s{" "}
                {compliance.entries.toLocaleString("en-IN")} ledger rows
              </span>
            ) : (
              <span>no run promoted · this ledger holds {ledgerEntries.toLocaleString("en-IN")} rows</span>
            )
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
