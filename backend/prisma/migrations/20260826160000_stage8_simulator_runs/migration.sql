-- AlterTable
ALTER TABLE "cases" ADD COLUMN     "discountRequestedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "sim_ground_truth" ADD COLUMN     "caseIndex" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "sim_runs" ADD COLUMN     "failureReason" TEXT,
ADD COLUMN     "promotedAt" TIMESTAMP(3),
ADD COLUMN     "ref" TEXT NOT NULL,
ADD COLUMN     "steps" JSONB;

-- CreateIndex
CREATE INDEX "sim_runs_merchantId_promotedAt_idx" ON "sim_runs"("merchantId", "promotedAt");

-- CreateIndex
CREATE UNIQUE INDEX "sim_runs_merchantId_ref_key" ON "sim_runs"("merchantId", "ref");

