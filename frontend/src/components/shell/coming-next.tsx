import Link from "next/link";

import { ChevronRightIcon } from "@/components/dashboard/icons";

/**
 * Placeholder for a page in the inventory that is not built yet.
 *
 * The nav is deliberately complete rather than trimmed to what exists: the
 * shell is the product's shape, and a panelist clicking through it should see
 * the roadmap, not a 404. Each stub names what will live there, so the page
 * doubles as the build plan.
 */
export function ComingNext({
  title,
  purpose,
  contents,
}: {
  title: string;
  purpose: string;
  contents: string[];
}) {
  return (
    <div className="surface mx-auto max-w-[720px] p-6 sm:p-7">
      <p className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-txt-faint">
        Next in the build
      </p>
      <h2 className="mt-2 text-[20px] font-semibold tracking-[-0.01em] text-txt">{title}</h2>
      <p className="mt-2.5 text-[14px] leading-[1.65] text-txt-dim">{purpose}</p>

      <ul className="mt-5 space-y-2">
        {contents.map((item) => (
          <li key={item} className="flex items-start gap-2.5 text-[13.5px] leading-[1.6] text-txt-dim">
            <span className="mt-[7px] h-[4px] w-[4px] shrink-0 rounded-[1px] bg-waiting/70" aria-hidden />
            {item}
          </li>
        ))}
      </ul>

      <Link
        href="/dashboard"
        className="mt-6 inline-flex items-center gap-1.5 text-[13px] font-medium text-txt-dim transition-colors hover:text-txt"
      >
        Back to the Control Tower
        <ChevronRightIcon className="h-[14px] w-[14px]" />
      </Link>
    </div>
  );
}
