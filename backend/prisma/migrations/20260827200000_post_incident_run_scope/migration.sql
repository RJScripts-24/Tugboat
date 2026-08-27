-- Post-submission: an incident belongs to the traffic that tripped it — the
-- live gateway's, or one batch's — so a batch's outage and the live monitor
-- cannot open or close each other's incidents (B-67, D-142).
-- AlterTable
ALTER TABLE "degradation_incidents" ADD COLUMN     "simRunId" TEXT;
-- CreateIndex
CREATE INDEX "degradation_incidents_simRunId_idx" ON "degradation_incidents"("simRunId");
-- AddForeignKey
ALTER TABLE "degradation_incidents" ADD CONSTRAINT "degradation_incidents_simRunId_fkey" FOREIGN KEY ("simRunId") REFERENCES "sim_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
