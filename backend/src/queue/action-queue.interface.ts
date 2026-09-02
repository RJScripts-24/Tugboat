/**
 * The scheduler seam.
 *
 * Recovery is mostly *waiting*: retry when the gateway recovers, nudge when the
 * quiet window opens, re-present on day three, check back on the promised date.
 * All of that is one thing — "run this later" — so it gets one interface with
 * two implementations: BullMQ over Redis for a running system, and a
 * deterministic in-memory queue for tests and for Stage 8's accelerated batch,
 * where a run cannot spend three real days waiting for a mandate retry.
 */

import type { PolicyChannel } from "../policy/policy-pack";

export type JobKind =
  /** Take the next step on a case: plan, gate, execute. */
  | "case.step"
  /** A promised payment date has arrived; check whether it was kept. */
  | "promise.checkin"
  /**
   * A human approved a request; run the gate again and send what they signed
   * off. Queued rather than done inline, because the world may have changed
   * between the click and the send (D-67).
   */
  | "approval.release"
  /**
   * A person took a case from the Control Tower; ask them, on a card, whether
   * Boa carries on with it. Queued rather than called, because `cases` may not
   * depend on `approvals` without a `forwardRef` and the one-way arrow is worth
   * keeping (D-151).
   */
  | "case.handover";

export type QueuedJob = {
  kind: JobKind;
  caseId: number;
  /** Deduplicates the job itself, so the same wait is never scheduled twice. */
  jobId: string;
  /** Why this job exists, for the log and for the case timeline. */
  reason: string;
  promiseId?: string;
  approvalId?: string;
  /** The rung a human asked for; the gate still decides (D-145). */
  channel?: PolicyChannel;
  /**
   * The attempt count this job was scheduled against.
   *
   * A redelivered job must not advance the case: the action key stops the same
   * *message* going twice, but without this a replay of "step at attempt 0"
   * would happily plan attempt 1 and spend a contact the customer never earned
   * (B-15).
   */
  expectAttempt?: number;
};

export type EnqueueOptions = {
  /** Milliseconds from now. Zero runs at the next drain / immediately. */
  delayMs?: number;
};

export type JobHandler = (job: QueuedJob) => Promise<void>;

export interface ActionQueue {
  readonly kind: "bullmq" | "inline";
  enqueue(job: QueuedJob, options?: EnqueueOptions): Promise<void>;
  cancel(jobId: string): Promise<void>;
  /**
   * Drops every job, scheduled or waiting.
   *
   * Stage 8 reseeds the demo dataset from a completed batch; scheduled work
   * left pointing at cases that no longer exist would fire against nothing and
   * fill the log with ghosts.
   */
  clear(): Promise<void>;
  /** Registered once at boot by the module that owns the work. */
  process(handler: JobHandler): void;
  /**
   * Whether a job is still ahead of the worker — waiting, delayed or active.
   *
   * The queue is a promise the database made to itself: every open case the
   * agent is working carries exactly one future job. Losing the queue (Redis
   * gone, a process killed with the job in memory) breaks that promise
   * silently, and this is how the reconciler notices (D-131).
   */
  has(jobId: string): Promise<boolean>;
  /** Round-trips the broker, so the health endpoint reports a fact rather than a URL. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export const ACTION_QUEUE = Symbol("ACTION_QUEUE");
