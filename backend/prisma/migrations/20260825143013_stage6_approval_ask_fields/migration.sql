-- AlterTable
ALTER TABLE "approvals" ADD COLUMN     "draftEdited" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ifApproved" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "ifRejected" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "resumeSteps" JSONB;
