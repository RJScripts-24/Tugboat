import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { CaseView } from "@/components/case/case-view";
import { getCaseDetail, getCaseNeighbours } from "@/lib/case-detail-data";
import { CASE_TYPE_META, getPipelineCases } from "@/lib/pipeline-data";

type Params = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params;
  const detail = getCaseDetail(id);
  if (!detail) return { title: `${id} — Tugboat`, robots: { index: false, follow: false } };

  return {
    title: `${id} · ${CASE_TYPE_META[detail.record.type].label} — Tugboat`,
    robots: { index: false, follow: false },
  };
}

/**
 * Case Detail (PRD 6.3, page 4) - the money page.
 *
 * The case is read on the server and handed down whole, exactly as
 * `GET /cases/:id` will hand it down: the record, its events, its bounds, its
 * ledger rows. Every id in the seeded batch resolves; an id that is not in the
 * batch still 404s, because a page that answers for any URL is its own kind of
 * lie.
 */
export default async function CaseDetailPage({ params }: Params) {
  const { id } = await params;
  const detail = getCaseDetail(id);
  if (!detail) notFound();

  return (
    <CaseView
      detail={detail}
      neighbours={getCaseNeighbours(id)}
      batchSize={getPipelineCases().length}
    />
  );
}
