import {
  AMOUNT_BANDS,
  CASE_TYPE_META,
  ROOT_CAUSE_META,
  STAGE_META,
  type AmountBandKey,
  type CaseType,
  type PipelineCase,
  type RootCause,
  type Stage,
} from "@/lib/pipeline-data";

/**
 * The pipeline's query state, and the pure functions over it.
 *
 * Kept out of the components because it is the page's actual logic: what the
 * URL means, which cases survive it, and in what order. Pure and
 * dependency-free, so it reads as the `GET /cases?...` contract the API will
 * eventually implement rather than as view code.
 */

export type SortKey = "activity" | "amount" | "attempts" | "id" | "customer";
export type SortDir = "asc" | "desc";

export type Filters = {
  type: CaseType | "all";
  stages: Stage[];
  cause: RootCause | "all";
  band: AmountBandKey | "all";
  q: string;
};

export type Sort = { key: SortKey; dir: SortDir };

/** A URL patch. `null` drops the parameter; omitted keys are left alone. */
export type HrefPatch = Partial<Record<string, string | null>>;

export const PAGE_SIZE = 40;

/** Defaults are the empty string in every case, so a bare /cases has no params. */
export const DEFAULT_SORT: Sort = { key: "activity", dir: "asc" };

/* ------------------------------------------------------------------ */
/* Reading the URL                                                     */
/* ------------------------------------------------------------------ */

const STAGE_KEYS = new Set(Object.keys(STAGE_META));
const CAUSE_KEYS = new Set(Object.keys(ROOT_CAUSE_META));
const TYPE_KEYS = new Set(Object.keys(CASE_TYPE_META));
const BAND_KEYS = new Set(AMOUNT_BANDS.map((band) => band.key as string));
const SORT_KEYS = new Set<SortKey>(["activity", "amount", "attempts", "id", "customer"]);

/**
 * Unknown values are dropped rather than surfaced as an error state: a filter
 * that arrives from a stale link should degrade to "unfiltered", never to a
 * broken page.
 */
export function readFilters(params: URLSearchParams): Filters {
  const type = params.get("type");
  const cause = params.get("cause");
  const band = params.get("band");

  return {
    type: type && TYPE_KEYS.has(type) ? (type as CaseType) : "all",
    stages: (params.get("stage") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => STAGE_KEYS.has(value)) as Stage[],
    cause: cause && CAUSE_KEYS.has(cause) ? (cause as RootCause) : "all",
    band: band && BAND_KEYS.has(band) ? (band as AmountBandKey) : "all",
    // ?case=C-1187 narrows the list to that one row. The dashboard used to link
    // here and now opens the case itself instead, but the parameter stays: it
    // is how you share "this case, in its context in the list", and dropping it
    // would break any link already written that way. A value that is not a case
    // id is ignored rather than searched for.
    q: (params.get("q") ?? caseIdParam(params) ?? "").trim(),
  };
}

function caseIdParam(params: URLSearchParams): string | null {
  const value = params.get("case");
  return value && /^C-\d+$/i.test(value.trim()) ? value : null;
}

export function readSort(params: URLSearchParams): Sort {
  const key = params.get("sort") as SortKey | null;
  const dir = params.get("dir");
  if (!key || !SORT_KEYS.has(key)) return DEFAULT_SORT;
  return { key, dir: dir === "desc" ? "desc" : "asc" };
}

export function readPage(params: URLSearchParams): number {
  const page = Number(params.get("page"));
  return Number.isFinite(page) && page > 1 ? Math.floor(page) : 1;
}

/* ------------------------------------------------------------------ */
/* Applying it                                                         */
/* ------------------------------------------------------------------ */

export function applyFilters(cases: PipelineCase[], filters: Filters): PipelineCase[] {
  const band = AMOUNT_BANDS.find((entry) => entry.key === filters.band);
  const needle = filters.q.toLowerCase();
  const stages = new Set(filters.stages);

  return cases.filter((row) => {
    if (filters.type !== "all" && row.type !== filters.type) return false;
    if (stages.size > 0 && !stages.has(row.stage)) return false;
    if (filters.cause !== "all" && row.rootCause !== filters.cause) return false;
    if (band && (row.amountPaise < band.min || row.amountPaise >= band.max)) return false;
    if (
      needle &&
      !row.id.toLowerCase().includes(needle) &&
      !row.customer.toLowerCase().includes(needle)
    ) {
      return false;
    }
    return true;
  });
}

export function applySort(cases: PipelineCase[], sort: Sort): PipelineCase[] {
  const factor = sort.dir === "asc" ? 1 : -1;

  const value = (row: PipelineCase): number | string => {
    switch (sort.key) {
      case "amount":
        return row.amountPaise;
      case "attempts":
        // Rope left, not attempts used: "3 of 4" is more urgent than "3 of 6",
        // and the cap differs by playbook.
        return row.attempts / row.attemptCap;
      case "id":
        return row.id;
      case "customer":
        return row.customer;
      default:
        return row.updatedMinutesAgo;
    }
  };

  return cases.slice().sort((a, b) => {
    const left = value(a);
    const right = value(b);
    if (typeof left === "string" && typeof right === "string") {
      return left.localeCompare(right) * factor;
    }
    // Ties broken by id so the order is total - a wobbling list under a stable
    // filter looks like a bug.
    return ((left as number) - (right as number)) * factor || a.id.localeCompare(b.id);
  });
}

/* ------------------------------------------------------------------ */
/* Chips                                                               */
/* ------------------------------------------------------------------ */

/** One chip per narrowing in force, each one its own undo. */
export function chipsFor(
  filters: Filters,
  buildHref: (patch: HrefPatch) => string,
): { key: string; label: string; href: string }[] {
  const chips: { key: string; label: string; href: string }[] = [];

  if (filters.type !== "all") {
    chips.push({
      key: "type",
      label: CASE_TYPE_META[filters.type].label,
      href: buildHref({ type: null }),
    });
  }

  for (const stage of filters.stages) {
    const rest = filters.stages.filter((entry) => entry !== stage);
    chips.push({
      key: `stage-${stage}`,
      label: STAGE_META[stage].label,
      href: buildHref({ stage: rest.length ? rest.join(",") : null }),
    });
  }

  if (filters.cause !== "all") {
    chips.push({
      key: "cause",
      label: ROOT_CAUSE_META[filters.cause].label,
      href: buildHref({ cause: null }),
    });
  }

  const band = AMOUNT_BANDS.find((entry) => entry.key === filters.band);
  if (band) {
    chips.push({ key: "band", label: band.label, href: buildHref({ band: null }) });
  }

  if (filters.q) {
    chips.push({
      key: "q",
      label: `"${filters.q}"`,
      href: buildHref({ q: null, case: null }),
    });
  }

  return chips;
}
