-- Post-submission: a real call is a conversation spread over several webhooks;
-- its transcript, context and outcome live here between them (D-144).
-- CreateTable
CREATE TABLE "voice_calls" (
    "id" TEXT NOT NULL,
    "caseId" INTEGER NOT NULL,
    "attempt" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'dialing',
    "providerSid" TEXT,
    "context" JSONB NOT NULL,
    "transcript" JSONB NOT NULL,
    "intent" TEXT,
    "seconds" INTEGER NOT NULL DEFAULT 0,
    "recordingUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "voice_calls_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "voice_calls_caseId_idx" ON "voice_calls"("caseId");
-- AddForeignKey
ALTER TABLE "voice_calls" ADD CONSTRAINT "voice_calls_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
