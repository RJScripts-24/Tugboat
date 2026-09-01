"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { ChevronDownIcon, CloseIcon } from "@/components/dashboard/icons";
import {
  AMOUNT_BANDS,
  CASE_TYPE_META,
  CASE_TYPE_ORDER,
  ROOT_CAUSE_META,
  ROOT_CAUSE_ORDER,
  STAGE_META,
  STAGE_ORDER,
  type AmountBandKey,
  type CaseType,
} from "@/lib/pipeline-data";
import { TONE_HEX } from "@/lib/dashboard-data";
import type { Filters, HrefPatch } from "./filters";

/**
 * The filter bar (PRD 6.3, page 3).
 *
 * Every control writes to the URL rather than to component state, which buys
 * three things for one decision: the Control Tower's funnel can deep-link
 * straight into a pre-filtered pipeline, an operator can send a colleague the
 * exact list they are looking at, and the back button behaves. The
 * consequence - filters are links, not buttons, wherever a single click means
 * a single new URL.
 */
export function FilterBar({
  filters,
  buildHref,
  onSearch,
  counts,
  activeChips,
}: {
  filters: Filters;
  buildHref: (patch: HrefPatch) => string;
  onSearch: (value: string) => void;
  /** Case counts per type across the whole batch, not the filtered view. */
  counts: { total: number; byType: Record<CaseType, number> };
  activeChips: { key: string; label: string; href: string }[];
}) {
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <TypeSegments filters={filters} buildHref={buildHref} counts={counts} />

        <div className="flex flex-wrap items-center gap-2">
          <StageMenu filters={filters} buildHref={buildHref} />
          <CauseMenu filters={filters} buildHref={buildHref} />
          <AmountMenu filters={filters} buildHref={buildHref} />
        </div>

        <SearchField value={filters.q} onChange={onSearch} />
      </div>

      {activeChips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="chalk-hand text-[12px] uppercase tracking-[0.07em] text-txt-faint">
            Filtered by
          </span>
          {activeChips.map((chip) => (
            <Link key={chip.key} href={chip.href} className="filter-chip" scroll={false}>
              {chip.label}
              <CloseIcon className="h-[10px] w-[10px] opacity-70" />
            </Link>
          ))}
          <Link
            href={buildHref({ type: null, stage: null, cause: null, band: null, q: null })}
            scroll={false}
            className="text-[11.5px] text-txt-faint underline-offset-2 transition-colors hover:text-txt hover:underline"
          >
            Clear all
          </Link>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Case type, as the board's own tab strip: lettered, underlined in chalk when
 * active - the same treatment the shell gives its nav, because this is the
 * same gesture.
 */
function TypeSegments({
  filters,
  buildHref,
  counts,
}: {
  filters: Filters;
  buildHref: (patch: HrefPatch) => string;
  counts: { total: number; byType: Record<CaseType, number> };
}) {
  const options: { key: CaseType | "all"; label: string; count: number }[] = [
    { key: "all", label: "All", count: counts.total },
    ...CASE_TYPE_ORDER.map((type) => ({
      key: type,
      label: CASE_TYPE_META[type].short,
      count: counts.byType[type],
    })),
  ];

  return (
    <div className="scroll-thin flex items-center gap-4 overflow-x-auto">
      {options.map((option) => {
        const active = filters.type === option.key;
        return (
          <Link
            key={option.key}
            href={buildHref({ type: option.key === "all" ? null : option.key })}
            scroll={false}
            aria-current={active ? "true" : undefined}
            className={`nav-label relative shrink-0 pb-1.5 pt-0.5 text-[14px] transition-colors ${
              active ? "text-txt" : "text-txt-dim hover:text-txt"
            }`}
          >
            {option.label}
            <span className="mono ml-1.5 text-[11px] text-txt-faint">{option.count}</span>
            {active ? <span className="chalk-rule absolute inset-x-0 bottom-0" aria-hidden /> : null}
          </Link>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function StageMenu({
  filters,
  buildHref,
}: {
  filters: Filters;
  buildHref: (patch: HrefPatch) => string;
}) {
  const selected = new Set(filters.stages);
  const summary =
    selected.size === 0
      ? "Any"
      : selected.size === 1
        ? STAGE_META[filters.stages[0]].label
        : `${selected.size} selected`;

  return (
    <FilterMenu label="Stage" summary={summary} active={selected.size > 0}>
      {(close) => (
        <>
          {STAGE_ORDER.map((stage) => {
            const on = selected.has(stage);
            const nextStages = on
              ? filters.stages.filter((s) => s !== stage)
              : [...filters.stages, stage];
            return (
              <Link
                key={stage}
                href={buildHref({ stage: nextStages.length ? nextStages.join(",") : null })}
                scroll={false}
                onClick={close}
                className="filter-option"
                role="menuitemcheckbox"
                aria-checked={on}
              >
                <Checkbox checked={on} />
                <span
                  className="h-[6px] w-[6px] shrink-0 rounded-[1px]"
                  style={{ backgroundColor: TONE_HEX[STAGE_META[stage].tone] }}
                  aria-hidden
                />
                {STAGE_META[stage].label}
              </Link>
            );
          })}
          {selected.size > 0 ? (
            <>
              <div className="my-1 h-px bg-white/10" />
              <Link
                href={buildHref({ stage: null })}
                scroll={false}
                onClick={close}
                className="filter-option text-txt-faint"
              >
                Any stage
              </Link>
            </>
          ) : null}
        </>
      )}
    </FilterMenu>
  );
}

function CauseMenu({
  filters,
  buildHref,
}: {
  filters: Filters;
  buildHref: (patch: HrefPatch) => string;
}) {
  return (
    <FilterMenu
      label="Root cause"
      summary={filters.cause === "all" ? "Any" : ROOT_CAUSE_META[filters.cause].label}
      active={filters.cause !== "all"}
    >
      {(close) => (
        <>
          <Option
            href={buildHref({ cause: null })}
            onSelect={close}
            selected={filters.cause === "all"}
          >
            Any root cause
          </Option>
          {ROOT_CAUSE_ORDER.map((cause) => (
            <Option
              key={cause}
              href={buildHref({ cause })}
              onSelect={close}
              selected={filters.cause === cause}
            >
              <span className="mono text-[11px] text-txt-faint">{cause}</span>
            </Option>
          ))}
        </>
      )}
    </FilterMenu>
  );
}

function AmountMenu({
  filters,
  buildHref,
}: {
  filters: Filters;
  buildHref: (patch: HrefPatch) => string;
}) {
  const current = AMOUNT_BANDS.find((band) => band.key === filters.band);

  return (
    <FilterMenu
      label="Amount"
      summary={current ? current.label : "Any"}
      active={Boolean(current)}
    >
      {(close) => (
        <>
          <Option
            href={buildHref({ band: null })}
            onSelect={close}
            selected={filters.band === "all"}
          >
            Any amount
          </Option>
          {AMOUNT_BANDS.map((band) => (
            <Option
              key={band.key}
              href={buildHref({ band: band.key as AmountBandKey })}
              onSelect={close}
              selected={filters.band === band.key}
            >
              <span className="tabular">{band.label}</span>
            </Option>
          ))}
        </>
      )}
    </FilterMenu>
  );
}

/* ------------------------------------------------------------------ */

/**
 * A menu on the board.
 *
 * Closes on outside pointerdown and on Escape, and returns focus to its
 * trigger - the three behaviours that separate a menu from a div that happens
 * to be visible.
 */
function FilterMenu({
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
        <span className="max-w-[150px] truncate">{summary}</span>
        <ChevronDownIcon
          className={`h-[11px] w-[11px] opacity-60 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open ? (
        <div id={menuId} role="menu" className="filter-menu left-0">
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

function Option({
  href,
  onSelect,
  selected,
  children,
}: {
  href: string;
  onSelect: () => void;
  selected: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      scroll={false}
      onClick={onSelect}
      role="menuitemradio"
      aria-checked={selected}
      className="filter-option"
    >
      <span
        className={`h-[6px] w-[6px] shrink-0 rounded-[1px] ${selected ? "bg-waiting" : "bg-white/15"}`}
        aria-hidden
      />
      {children}
    </Link>
  );
}

/** Drawn, not a native control - a system checkbox on this board looks pasted on. */
function Checkbox({ checked }: { checked: boolean }) {
  return (
    <span
      className={`flex h-[12px] w-[12px] shrink-0 items-center justify-center rounded-[1px] border ${
        checked ? "border-waiting" : "border-white/25"
      }`}
      aria-hidden
    >
      {checked ? (
        <svg viewBox="0 0 12 12" className="h-[9px] w-[9px] text-waiting">
          <path
            d="m2.4 6.2 2.3 2.3 4.9-5.2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : null}
    </span>
  );
}

/* ------------------------------------------------------------------ */

/**
 * Search over case id and customer.
 *
 * Local state with a short debounce onto the URL: typing must not push a
 * history entry per keystroke, and the input must not lag a router round trip.
 */
function SearchField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  const dirty = useRef(false);

  // Chips, "clear all" and deep links change the term from outside; adopt it
  // unless the operator is mid-word.
  useEffect(() => {
    if (!dirty.current) setDraft(value);
  }, [value]);

  useEffect(() => {
    if (!dirty.current) return;
    const id = setTimeout(() => {
      dirty.current = false;
      onChange(draft);
    }, 220);
    return () => clearTimeout(id);
  }, [draft, onChange]);

  return (
    <label className="ml-auto flex min-w-[190px] items-center gap-2 border-b border-white/15 pb-1 focus-within:border-white/40">
      <span className="sr-only">Search by case id or customer</span>
      <svg viewBox="0 0 24 24" className="h-[13px] w-[13px] shrink-0 text-txt-faint" fill="none" aria-hidden>
        <circle cx="10.6" cy="10.6" r="6.4" stroke="currentColor" strokeWidth="1.7" />
        <path d="m15.4 15.4 4.4 4.4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      </svg>
      <input
        type="search"
        value={draft}
        placeholder="Case id or customer"
        onChange={(event) => {
          dirty.current = true;
          setDraft(event.target.value);
        }}
        className="w-full bg-transparent text-[13px] text-txt placeholder:text-txt-faint/70 focus:outline-none"
      />
    </label>
  );
}
