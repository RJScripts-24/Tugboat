-- Stage 11: a running batch says it is alive, so a second process can tell an
-- orphaned run from one another process is still working (B-47, D-129).
ALTER TABLE "sim_runs" ADD COLUMN "heartbeatAt" TIMESTAMP(3);
