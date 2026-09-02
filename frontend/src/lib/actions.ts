"use server";

import { revalidatePath } from "next/cache";

import { ApiError, apiFetch } from "./api";
import type { LedgerRow } from "./audit-data";
import type { PolicyPack, PolicyRevision } from "./policies-data";
import type { SimulationConfig } from "./simulation-data";

/**
 * Everything the Control Tower can *do*, as server actions.
 *
 * Every one of these used to be a write in the browser: an override appended a
 * ledger row to a module-level array, a decision was recorded in component
 * state, a policy save minted its own digest. That was the right shape for a
 * frontend with no backend — one append-only log, folded into state, so no two
 * screens could disagree — and all of it is now somebody else's job.
 *
 * They are server actions rather than `fetch` calls from a click handler for
 * one reason: the session is an httpOnly cookie the browser cannot read. A
 * client-side call could not authenticate without the token being handed to
 * JavaScript, which is the property the BFF exists to keep (D-4). A server
 * action runs on the Next server, where the cookie is readable, so the button
 * stays a button and the token stays where it was put.
 *
 * Each one ends with `revalidatePath`, which is what makes the page redraw from
 * the API rather than from anything patched together in the browser: the answer
 * on screen after a click is the same answer a reload would give (D-113).
 */

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Turns an API refusal into something a toast can say without leaking a stack. */
function failure(error: unknown): { ok: false; error: string } {
  if (error instanceof ApiError) {
    return { ok: false, error: stripStatus(error.message) };
  }
  return { ok: false, error: "Something went wrong talking to the Tugboat API." };
}

/** "404 from /cases/C-9: no such case" → "no such case". */
function stripStatus(message: string): string {
  const colon = message.indexOf(": ");
  return colon === -1 ? message : message.slice(colon + 2);
}

/* ------------------------------------------------------------------ */
/* Case overrides                                                      */
/* ------------------------------------------------------------------ */

export type OverrideKind = "pause" | "resume" | "escalate" | "resolve-external" | "call";

export type OverrideResult = {
  ok: true;
  override: string;
  stage: string;
  row: { id: string; seq: number; hash: string; prevHash: string; detail: string };
};

/**
 * Pause, resume, take over, or close a case outside Tugboat.
 *
 * The response carries the ledger row the server wrote, which is the point of
 * doing it this way round: the browser is told what was recorded rather than
 * recording its own version of it and hoping the two match.
 */
export async function overrideCase(
  caseId: string,
  kind: OverrideKind,
  note?: string,
): Promise<ActionResult<OverrideResult>> {
  try {
    const data = await apiFetch<OverrideResult>(`/cases/${encodeURIComponent(caseId)}/${kind}`, {
      method: "POST",
      body: note ? { note } : {},
    });

    revalidatePath(`/cases/${caseId}`);
    revalidatePath("/cases");
    revalidatePath("/dashboard");
    revalidatePath("/audit");
    // Escalating raises a handover card, so the queue a merchant reads has
    // changed too. Leaving it out meant the row was written, the badge was
    // right on a reload and the Approvals tab served a cached render from
    // before the click — the third time "Escalate to me" has looked like a
    // button that does nothing while every layer under it worked (B-73, B-75,
    // B-77). Revalidated for every override rather than only for `escalate`:
    // the cost is one re-read of a small page, and a rule with an exception is
    // a rule somebody has to remember.
    revalidatePath("/approvals");

    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}

/* ------------------------------------------------------------------ */
/* Approvals                                                           */
/* ------------------------------------------------------------------ */

export type ApprovalDecisionResult = {
  ok: true;
  draftEdited?: boolean;
  /** The case was put back to attempt zero with the decision (D-157). */
  restarted?: boolean;
  /** "queued": the gate runs again on the release, so this is a permission, not a send. */
  released?: "queued";
};

/**
 * A yes.
 *
 * `restart` is the second kind of yes (D-157): work the case again from the
 * start, with the attempts back to zero and the channel caps, cool-down and
 * re-presentation count counted from now. The API accepts it only on a
 * handover request, and it cannot clear an opt-out.
 */
export async function approveRequest(
  id: string,
  draft?: { lines?: string[]; subject?: string },
  options?: { restart?: boolean },
): Promise<ActionResult<ApprovalDecisionResult>> {
  try {
    const data = await apiFetch<ApprovalDecisionResult>(
      `/approvals/${encodeURIComponent(id)}/approve`,
      {
        method: "POST",
        body: {
          draftLines: draft?.lines,
          draftSubject: draft?.subject,
          ...(options?.restart ? { restart: true } : {}),
        },
      },
    );

    revalidateAfterDecision();
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}

export async function rejectRequest(
  id: string,
  reason: string,
): Promise<ActionResult<ApprovalDecisionResult>> {
  try {
    const data = await apiFetch<ApprovalDecisionResult>(
      `/approvals/${encodeURIComponent(id)}/reject`,
      { method: "POST", body: { reason } },
    );

    revalidateAfterDecision();
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}

/** A decision moves the queue, the case, the ledger and the shell badge. */
function revalidateAfterDecision(): void {
  revalidatePath("/approvals");
  revalidatePath("/cases");
  revalidatePath("/dashboard");
  revalidatePath("/audit");
}

/* ------------------------------------------------------------------ */
/* Policies                                                            */
/* ------------------------------------------------------------------ */

export type PolicySaveResult = {
  version: string;
  pack: PolicyPack;
  changes: { path: string; from: string; to: string; direction: string }[];
  unchanged: boolean;
  revisions: PolicyRevision[];
};

/**
 * Save the pack.
 *
 * The diff, the version number and the `POLICY_CHANGED` ledger row are all
 * computed on the server now. The page still shows a diff before you press
 * save — that one is a preview, and it is the same function (`diffPacks`) the
 * API runs, which is why the preview and the recorded change agree.
 */
export async function savePolicies(pack: PolicyPack): Promise<ActionResult<PolicySaveResult>> {
  try {
    const data = await apiFetch<PolicySaveResult>("/policies", { method: "PUT", body: pack });

    revalidatePath("/policies");
    revalidatePath("/dashboard");
    revalidatePath("/audit");

    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}

/* ------------------------------------------------------------------ */
/* Simulations                                                         */
/* ------------------------------------------------------------------ */

export type StartedRun = { id: string; status: string; progress: number };

/**
 * Start a batch.
 *
 * Answers with a run id and nothing else, because that is all that exists yet:
 * the run happens in the background and the Lab watches it over the `sim:<id>`
 * socket room. A 202 is the honest status and the API returns one.
 */
export async function startSimulation(
  config: SimulationConfig,
): Promise<ActionResult<StartedRun>> {
  try {
    const data = await apiFetch<StartedRun>("/simulations", { method: "POST", body: config });
    revalidatePath("/simulation");
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Make a finished run the batch the Control Tower narrates.
 *
 * Destructive and deliberately separate from running one: it clears whatever
 * the pipeline was showing (D-94), and a merchant should have to mean it.
 */
export async function promoteSimulation(
  id: string,
): Promise<ActionResult<{ id: string; promoted: boolean; clearedCases: number }>> {
  try {
    const data = await apiFetch<{ id: string; promoted: boolean; clearedCases: number }>(
      `/simulations/${encodeURIComponent(id)}/promote`,
      { method: "POST", body: {} },
    );

    revalidatePath("/simulation");
    revalidatePath("/dashboard");
    revalidatePath("/cases");
    revalidatePath("/audit");

    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}

/* ------------------------------------------------------------------ */
/* Audit                                                               */
/* ------------------------------------------------------------------ */

/**
 * Ask the server to verify the chain too.
 *
 * Offered beside the browser's own check, never instead of it: the Audit
 * Explorer recomputes every digest it was handed, and this exists so a ledger
 * too large to ship can still be checked end to end.
 */
export async function verifyChain(
  chain?: string,
): Promise<ActionResult<{ checked: number; chains: number; broken: unknown[] }>> {
  try {
    const data = await apiFetch<{ checked: number; chains: number; broken: unknown[] }>(
      "/audit/verify-chain",
      { method: "POST", body: chain ? { chain } : {} },
    );
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}

/** One page of the ledger, for the Explorer's "load more". */
export async function loadLedgerPage(
  skip: number,
  take: number,
): Promise<ActionResult<{ rows: LedgerRow[]; total: number }>> {
  try {
    const data = await apiFetch<{ rows: LedgerRow[]; total: number }>("/audit", {
      query: { skip, take },
    });
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}
