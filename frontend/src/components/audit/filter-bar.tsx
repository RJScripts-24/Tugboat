"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { ChevronDownIcon, CloseIcon } from "@/components/dashboard/icons";
import { ACTOR_META, ACTOR_ORDER, type LedgerActor } from "@/lib/audit-data";

export type RangeKey = "1h" | "24h" | "3d" | "all";

export const RANGES: { key: RangeKey; label: string; minutes: number }[] = [
  { key: "1h", label: "Last hour", minutes: 60 },
  { key: "24h", label: "Last 24h", minutes: 24 * 60 },
  { key: "3d", label: "Last 3 days", minutes: 3 * 24 * 60 },
  { key: "all", label: "All time", minutes: Number.MAX_SAFE_INTEGER },
];

export type AuditFilters = {
  actor: LedgerActor | "all";
  action: string | "all";
  range: RangeKey;
  /** Only rows that carry a masked identifier - the PII story, filterable. */
  maskedOnly: boolean;
  /** Case id or digest prefix. */
  q: string;
};

export const EMPTY_FILTERS: AuditFilters = {
  actor: "all",
  action: "all",
  range: "all",
  maskedOnly: false,
  q: "",
};

/**
 * The ledger's filter bar (PRD 6.3, page 8).
 *
 * Filters run in the browser over rows that were already sent, rather than in
 * the URL as the Pipeline's do. The Pipeline's filters are a working state an
 * operator shares with a colleague; these are a way of reading one page, and
 * paying a server round trip to narrow a list already in memory would make the
 * ledger feel slower the more of it you have.
 *
 * The one dimension worth deep-linking is a case, and that arrives as
 * `?case=C-1042` - which is how Case Detail and the Approvals Queue point at
 * their own rows.
 */
export function FilterBar({
  filters,
  onChange,
  actorCounts,
  actions,
  total,
  shown,
}: {
  filters: AuditFilters;
  onChange: (next: AuditFilters) => void;
  actorCounts: Record<LedgerActor, number>;
  /** Distinct action types across the whole ledger, most frequent first. */
  actions: { action: string; count: number }[];
  total: number;
  shown: number;
}) {
  const set = (patch: Partial<AuditFilters>) => onChange({ ...filters, ...patch });

  const chips: { key: string; label: string; clear: Partial<AuditFilters> }[] = [];
  if (filters.actor !== "all") {
    chips.push({
      key: "actor",
      label: `Actor · ${ACTOR_META[filters.actor].label}`,
      clear: { actor: "all" },
    });
  }
  if (filters.action !== "all") {
    chips.push({ key: "action", label: filters.action, clear: { action: "all" } });
  }
  if (filters.range !== "all") {
    chips.push({
      key: "range",
      label: RANGES.find((range) => range.key === filters.range)?.label ?? "",
      clear: { range: "all" },
    });
  }
  if (filters.maskedOnly) {
    chips.push({ key: "masked", label: "Masked fields only", clear: { maskedOnly: false } });
  }
  if (filters.q) {
    chips.push({ key: "q", label: `“${filters.q}”`, clear: { q: "" } });
  }

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <ActorSegments filters={filters} counts={actorCounts} total={total} onSet={set} />

        <div className="flex flex-wrap items-center gap-2">
          <Menu
            label="Action"
            summary={filters.action === "all" ? "Any" : filters.action}
            active={filters.action !== "all"}
          >
            {(close) => (
              <>
                <Option
                  selected={filters.action === "all"}
                  onSelect={() => {
                    set({ action: "all" });
                    close();
                  }}
                >
                  Any action
                </Option>
                {actions.map(({ action, count }) => (
                  <Option
                    key={action}
                    selected={filters.action === action}
                    onSelect={() => {
                      set({ action });
                      close();
                    }}
                  >
                    <span className="mono text-[11px]">{action}</span>
                    <span className="mono ml-auto pl-3 text-[10.5px] text-txt-faint">{count}</span>
                  </Option>
                ))}
              </>
            )}
          </Menu>

          <Menu
            label="Window"
            summary={RANGES.find((range) => range.key === filters.range)?.label ?? "All time"}
            active={filters.range !== "all"}
          >
            {(close) => (
              <>
                {RANGES.map((range) => (
                  <Option
                    key={range.key}
                    selected={filters.range === range.key}
                    onSelect={() => {
                      set({ range: range.key });
                      close();
                    }}
                  >
                    {range.label}
                  </Option>
                ))}
              </>
            )}
          </Menu>

          <button
            type="button"
            className="filter-control"
            data-active={filters.maskedOnly}
            aria-pressed={filters.maskedOnly}
            onClick={() => set({ maskedOnly: !filters.maskedOnly })}
          >
            <span className="chalk-hand text-[12.5px] uppercase tracking-[0.06em] text-txt-faint">
              PII
            </span>
            Masked only
          </button>
        </div>

        <SearchField value={filters.q} onChange={(q) => set({ q })} />
      </div>

      {/* Only when something is actually narrowing the list. An unfiltered
          ledger already states its size in the actor strip above, and saying
          it twice trains a reader to stop reading either. */}
      {chips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="mono text-[11.5px] text-txt-faint">
            {shown.toLocaleString("en-IN")} of {total.toLocaleString("en-IN")} entries
          </span>
          <span className="text-txt-faint opacity-50">·</span>
          {chips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              className="filter-chip"
              onClick={() => set(chip.clear)}
            >
              {chip.label}
              <CloseIcon className="h-[10px] w-[10px] opacity-70" />
            </button>
          ))}
          <button
            type="button"
            onClick={() => onChange(EMPTY_FILTERS)}
            className="text-[11.5px] text-txt-faint underline-offset-2 transition-colors hover:text-txt hover:underline"
          >
            Clear all
          </button>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */

/** Who wrote the row. The board's tab strip, same gesture as the shell's nav. */
function ActorSegments({
  filters,
  counts,
  total,
  onSet,
}: {
  filters: AuditFilters;
  counts: Record<LedgerActor, number>;
  total: number;
  onSet: (patch: Partial<AuditFilters>) => void;
}) {
  const options: { key: LedgerActor | "all"; label: string; count: number; note?: string }[] = [
    { key: "all", label: "All", count: total },
    ...ACTOR_ORDER.map((actor) => ({
      key: actor,
      label: ACTOR_META[actor].label,
      count: counts[actor],
      note: ACTOR_META[actor].note,
    })),
  ];

  return (
    <div className="flex items-center gap-4">
      {options.map((option) => {
        const active = filters.actor === option.key;
        return (
          <button
            key={option.key}
            type="button"
            title={option.note}
            aria-current={active ? "true" : undefined}
            onClick={() => onSet({ actor: option.key })}
            className={`nav-label relative shrink-0 pb-1.5 pt-0.5 text-[14px] transition-colors ${
              active ? "text-txt" : "text-txt-dim hover:text-txt"
            }`}
          >
            {option.label}
            <span className="mono ml-1.5 text-[11px] text-txt-faint">
              {option.count.toLocaleString("en-IN")}
            </span>
            {active ? <span className="chalk-rule absolute inset-x-0 bottom-0" aria-hidden /> : null}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */

/** Same menu the Pipeline uses: closes on outside pointerdown and on Escape. */
function Menu({
  label,
  summary,
  active,
  children,
}: {
  label: string;
  summary: string;
  active: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const group = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!group.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={group} className="filter-group">
      <button
        ref={trigger}
        type="button"
        className="filter-control"
        data-active={active}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="chalk-hand text-[12.5px] uppercase tracking-[0.06em] text-txt-faint">
          {label}
        </span>
        <span className="max-w-[170px] truncate">{summary}</span>
        <ChevronDownIcon
          className={`h-[11px] w-[11px] opacity-60 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open ? (
        <div id={menuId} role="menu" className="filter-menu scroll-thin left-0 max-h-[320px] overflow-y-auto">
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

function Option({
  selected,
  onSelect,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      onClick={onSelect}
      className="filter-option w-full"
    >
      <span
        className={`h-[6px] w-[6px] shrink-0 rounded-[1px] ${selected ? "bg-waiting" : "bg-white/15"}`}
        aria-hidden
      />
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ */

/** Case id or digest prefix. Debounced, because the list re-filters per keystroke. */
function SearchField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  const dirty = useRef(false);

  useEffect(() => {
    if (!dirty.current) setDraft(value);
  }, [value]);

  useEffect(() => {
    if (!dirty.current) return;
    const id = setTimeout(() => {
      dirty.current = false;
      onChange(draft);
    }, 180);
    return () => clearTimeout(id);
  }, [draft, onChange]);

  return (
    <label className="ml-auto flex min-w-[200px] items-center gap-2 border-b border-white/15 pb-1 focus-within:border-white/40">
      <span className="sr-only">Search by case id or entry hash</span>
      <svg viewBox="0 0 24 24" className="h-[13px] w-[13px] shrink-0 text-txt-faint" fill="none" aria-hidden>
        <circle cx="10.6" cy="10.6" r="6.4" stroke="currentColor" strokeWidth="1.7" />
        <path d="m15.4 15.4 4.4 4.4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      </svg>
      <input
        type="search"
        value={draft}
        placeholder="Case id or entry hash"
        onChange={(event) => {
          dirty.current = true;
          setDraft(event.target.value);
        }}
        className="mono w-full bg-transparent text-[12.5px] text-txt placeholder:text-txt-faint/70 focus:outline-none"
      />
    </label>
  );
}
