-- AlterTable
ALTER TABLE "cases" ADD COLUMN     "hardshipFlaggedAt" TIMESTAMP(3),
ADD COLUMN     "lastSentiment" "Sentiment",
ADD COLUMN     "lastSentimentScore" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "policy_versions" ADD COLUMN     "changes" TEXT[] DEFAULT ARRAY[]::TEXT[];
