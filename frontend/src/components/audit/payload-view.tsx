"use client";

import { Fragment } from "react";

import type { PayloadValue } from "@/lib/audit-data";

/**
 * A ledger payload, pretty-printed (PRD 6.3, page 8 · PRD 9.9).
 *
 * Written as a renderer rather than `JSON.stringify(value, null, 2)` in a
 * `<pre>` for one reason: the masked fields have to be visible as masked. A
 * string reading "98•••••210" in a wall of grey monospace is a string a reader
 * skims past; the same string in amber with the word `masked` after it is the
 * PII-minimisation claim being made on screen instead of in a README.
 *
 * The mask is not applied here. These values were written masked - the model
 * never saw the full number and neither did this row - and `masked` is the
 * list of paths that were, so the page can point at them.
 */
export function PayloadView({
  value,
  masked,
}: {
  value: PayloadValue;
  /** Dotted paths whose value was masked before the row was written. */
  masked: string[];
}) {
  const flagged = new Set(masked);

  return (
    <div className="mono overflow-x-auto text-[11.5px] leading-[1.7] text-txt-dim">
      <Node value={value} path="" flagged={flagged} depth={0} />
    </div>
  );
}

/* ------------------------------------------------------------------ */

const INDENT = 16;

function Node({
  value,
  path,
  flagged,
  depth,
}: {
  value: PayloadValue;
  path: string;
  flagged: Set<string>;
  depth: number;
}) {
  if (Array.isArray(value)) {
    if (value.length === 0) return <Punct>[]</Punct>;
    return (
      <>
        <Punct>[</Punct>
        {value.map((item, i) => (
          <div key={i} style={{ paddingLeft: INDENT }}>
            <Node value={item} path={`${path}[${i}]`} flagged={flagged} depth={depth + 1} />
            {i < value.length - 1 ? <Punct>,</Punct> : null}
          </div>
        ))}
        <Punct>]</Punct>
      </>
    );
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return <Punct>{"{}"}</Punct>;
    return (
      <>
        <Punct>{"{"}</Punct>
        {entries.map(([name, child], i) => {
          const childPath = path ? `${path}.${name}` : name;
          const isMasked = flagged.has(childPath);
          return (
            <div key={name} style={{ paddingLeft: INDENT }}>
              <span className="text-txt-faint">&quot;{name}&quot;</span>
              <Punct>: </Punct>
              <Node value={child} path={childPath} flagged={flagged} depth={depth + 1} />
              {i < entries.length - 1 ? <Punct>,</Punct> : null}
              {isMasked ? <MaskTag /> : null}
            </div>
          );
        })}
        <Punct>{"}"}</Punct>
      </>
    );
  }

  return <Scalar value={value} masked={flagged.has(path)} />;
}

function Scalar({ value, masked }: { value: string | number | boolean | null; masked: boolean }) {
  if (value === null) return <span className="text-txt-faint opacity-70">null</span>;

  if (typeof value === "number") {
    return <span className="tabular text-txt">{value}</span>;
  }

  if (typeof value === "boolean") {
    return <span className="text-diagnosis">{String(value)}</span>;
  }

  return (
    <Fragment>
      <span className={masked ? "text-waiting" : "text-txt-dim"}>
        &quot;{value}&quot;
      </span>
    </Fragment>
  );
}

function Punct({ children }: { children: React.ReactNode }) {
  return <span className="text-txt-faint opacity-55">{children}</span>;
}

/** The point of the whole component. */
function MaskTag() {
  return (
    <span className="ml-2 text-[10.5px] uppercase tracking-[0.07em] text-waiting opacity-80">
      •••masked
    </span>
  );
}
