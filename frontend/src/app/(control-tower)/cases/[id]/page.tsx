import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { CaseView } from "@/components/case/case-view";
import { CASE_TYPE_META } from "@/lib/pipeline-data";
import { getCaseDetail, getPolicies } from "@/lib/queries";

type Params = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params;
  const detail = await getCaseDetail(id);
  if (!detail) return { title: `${id} — Tugboat`, robots: { index: false, follow: false } };

  return {
    title: `${id} · ${CASE_TYPE_META[detail.record.type].label} — Tugboat`,
    robots: { index: false, follow: false },
  };
}

/**
 * Case Detail (PRD 6.3, page 4) — the money page.
 *
 * `GET /cases/:id` hands down the case whole: the record, its events, the work
 * still scheduled on it, its bounds against the pack in force, and its own
 * ledger chain. An id that is not a case still 404s, because a page that
 * answers for any URL is its own kind of lie.
 *
 * The two lists that used to be honestly empty are real now. `pending` is the
 * case's scheduled `actions` rows, which is what lets the timeline be read as a
 * plan rather than only as a history — and every one of them still has to pass
 * the gate when its job fires, which is why the node says so. `audit` is this
 * case's chain, so the digests beside the timeline and the digests in the Audit
 * Explorer are one set of rows read twice.
 */
export default async function CaseDetailPage({ params }: Params) {
  const { id } = await params;

  const detail = await getCaseDetail(id);
  if (!detail) notFound();

  const { version } = await getPolicies();

  return (
    <CaseView
      detail={detail}
      neighbours={detail.neighbours}
      policyVersion={version}
    />
  );
}
