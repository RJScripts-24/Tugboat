import { Test } from "@nestjs/testing";

import { PrismaService } from "../prisma/prisma.service";
import { ACTION_QUEUE } from "../queue/action-queue.interface";
import { ExecutorService } from "./executor.service";
import { WorkReconcilerService } from "./work-reconciler.service";

type OpenCase = { id: number; stage: string; attemptsUsed: number };

describe("WorkReconcilerService", () => {
  let open: OpenCase[];
  let queued: Set<string>;
  let scheduled: { caseId: number; via: "first" | "step"; reason?: string }[];
  let lastWhere: Record<string, unknown>;

  async function reconciler(kind: "bullmq" | "inline" = "bullmq"): Promise<WorkReconcilerService> {
    const moduleRef = await Test.createTestingModule({
      providers: [
        WorkReconcilerService,
        {
          provide: PrismaService,
          useValue: {
            case: {
              findMany: async ({ where }: { where: Record<string, unknown> }) => {
                lastWhere = where;
                return open;
              },
            },
          },
        },
        {
          provide: ExecutorService,
          useValue: {
            scheduleFirstStep: async (caseId: number) => {
              scheduled.push({ caseId, via: "first" });
            },
            schedule: async (caseId: number, _delayMs: number, reason: string) => {
              scheduled.push({ caseId, via: "step", reason });
            },
          },
        },
        {
          provide: ACTION_QUEUE,
          useValue: { kind, has: async (jobId: string) => queued.has(jobId) },
        },
      ],
    }).compile();

    return moduleRef.get(WorkReconcilerService);
  }

  beforeEach(() => {
    open = [];
    queued = new Set();
    scheduled = [];
    lastWhere = {};
  });

  it("leaves a case alone when the job it owes is still queued", async () => {
    open = [{ id: 1001, stage: "waiting", attemptsUsed: 2 }];
    queued.add("case:1001:step:2");

    const result = await (await reconciler()).reconcile();

    expect(result).toEqual({ examined: 1, rescheduled: [] });
    expect(scheduled).toEqual([]);
  });

  it("schedules the missing step again through the executor", async () => {
    open = [{ id: 1002, stage: "waiting", attemptsUsed: 1 }];

    const result = await (await reconciler()).reconcile();

    expect(result.rescheduled).toEqual([1002]);
    expect(scheduled).toEqual([
      { caseId: 1002, via: "step", reason: expect.stringContaining("Reconciled") },
    ]);
  });

  it("gives a never-started case its opening wait rather than an immediate step", async () => {
    open = [{ id: 1003, stage: "diagnosed", attemptsUsed: 0 }];

    await (await reconciler()).reconcile();

    expect(scheduled).toEqual([{ caseId: 1003, via: "first" }]);
  });

  it("looks only at live, unpaused cases the agent owes a step, with no decision pending", async () => {
    await (await reconciler()).reconcile();

    expect(lastWhere).toMatchObject({
      simRunId: null,
      pausedAt: null,
      stage: { in: ["diagnosed", "intervening", "waiting"] },
      approvals: { none: { decision: null } },
    });
  });

  it("checks by the exact id the executor would have used", async () => {
    open = [{ id: 1004, stage: "intervening", attemptsUsed: 3 }];
    queued.add("case:1004:step:2");

    const result = await (await reconciler()).reconcile();

    // Attempt 2's job is history; attempt 3 is the one owed.
    expect(result.rescheduled).toEqual([1004]);
  });

  it("does not run a sweep on the in-memory queue, which nothing here drains", async () => {
    const service = await reconciler("inline");
    service.onApplicationBootstrap();

    expect((service as unknown as { timer: unknown }).timer).toBeNull();
    service.onApplicationShutdown();
  });
});
