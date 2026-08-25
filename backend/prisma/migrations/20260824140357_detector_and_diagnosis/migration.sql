-- AlterTable
ALTER TABLE "cases" ADD COLUMN     "degradationIncidentId" TEXT,
ADD COLUMN     "diagnosisAt" TIMESTAMP(3),
ADD COLUMN     "diagnosisRuleId" TEXT,
ADD COLUMN     "failureCode" TEXT,
ADD COLUMN     "failureReason" TEXT,
ADD COLUMN     "failureSource" TEXT,
ADD COLUMN     "instrument" TEXT;

-- CreateTable
CREATE TABLE "payment_samples" (
    "id" SERIAL NOT NULL,
    "merchantId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bucket" TIMESTAMP(3) NOT NULL,
    "success" BOOLEAN NOT NULL,
    "method" TEXT,
    "bank" TEXT,
    "simRunId" TEXT,

    CONSTRAINT "payment_samples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "degradation_incidents" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recoveredAt" TIMESTAMP(3),
    "windowRate" DOUBLE PRECISION NOT NULL,
    "baselineRate" DOUBLE PRECISION NOT NULL,
    "zScore" DOUBLE PRECISION NOT NULL,
    "casesOpened" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,

    CONSTRAINT "degradation_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_samples_merchantId_bucket_idx" ON "payment_samples"("merchantId", "bucket");

-- CreateIndex
CREATE INDEX "payment_samples_merchantId_at_idx" ON "payment_samples"("merchantId", "at");

-- CreateIndex
CREATE INDEX "degradation_incidents_merchantId_detectedAt_idx" ON "degradation_incidents"("merchantId", "detectedAt");

-- AddForeignKey
ALTER TABLE "cases" ADD CONSTRAINT "cases_degradationIncidentId_fkey" FOREIGN KEY ("degradationIncidentId") REFERENCES "degradation_incidents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
