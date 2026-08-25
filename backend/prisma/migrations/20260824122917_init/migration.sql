-- CreateEnum
CREATE TYPE "CaseType" AS ENUM ('PAYMENT_FAILED', 'CHECKOUT_ABANDONED', 'MANDATE_FAILED', 'INVOICE_OVERDUE');

-- CreateEnum
CREATE TYPE "RootCause" AS ENUM ('BANK_GATEWAY_DEGRADED', 'INSUFFICIENT_FUNDS', 'CUSTOMER_DISTRACTED', 'CARD_EXPIRED', 'MANDATE_REVOKED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "CaseStage" AS ENUM ('detected', 'diagnosed', 'intervening', 'waiting', 'escalated', 'promised', 'recovered', 'halted', 'exhausted');

-- CreateEnum
CREATE TYPE "DiagnosisMethod" AS ENUM ('RULES', 'LLM');

-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('RETRY', 'WHATSAPP', 'EMAIL', 'VOICE');

-- CreateEnum
CREATE TYPE "EventKind" AS ENUM ('DETECTED', 'DIAGNOSED', 'PLANNED', 'POLICY_CHECK', 'EMAIL_SENT', 'WHATSAPP_SENT', 'VOICE_CALL', 'RETRY_EXECUTED', 'CUSTOMER_REPLY', 'PROMISE_RECORDED', 'ESCALATED', 'APPROVAL_DECIDED', 'HALTED', 'RECOVERED');

-- CreateEnum
CREATE TYPE "ActionKind" AS ENUM ('EMAIL', 'WHATSAPP', 'VOICE', 'RETRY', 'PAYMENT_LINK', 'ESCALATE');

-- CreateEnum
CREATE TYPE "ActionStatus" AS ENUM ('PLANNED', 'BLOCKED', 'NEEDS_APPROVAL', 'EXECUTED', 'FAILED');

-- CreateEnum
CREATE TYPE "PolicyVerdict" AS ENUM ('ALLOWED', 'BLOCKED', 'NEEDS_APPROVAL');

-- CreateEnum
CREATE TYPE "ApprovalGate" AS ENUM ('discount_requires_approval', 'b2b_high_value', 'confidence_below_threshold', 'hardship_language');

-- CreateEnum
CREATE TYPE "ApprovalDecision" AS ENUM ('approved', 'rejected');

-- CreateEnum
CREATE TYPE "PromiseStatus" AS ENUM ('PENDING', 'KEPT', 'BROKEN');

-- CreateEnum
CREATE TYPE "LedgerActor" AS ENUM ('BOA', 'POLICY', 'HUMAN', 'SYSTEM');

-- CreateEnum
CREATE TYPE "Sentiment" AS ENUM ('positive', 'neutral', 'negative', 'opt_out');

-- CreateEnum
CREATE TYPE "CustomerSegment" AS ENUM ('B2C', 'B2B');

-- CreateEnum
CREATE TYPE "SimArm" AS ENUM ('baseline', 'naive', 'tugboat');

-- CreateEnum
CREATE TYPE "SimRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "merchants" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merchants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "maskedEmail" TEXT,
    "maskedPhone" TEXT,
    "languagePref" TEXT NOT NULL DEFAULT 'en-IN',
    "segment" "CustomerSegment" NOT NULL DEFAULT 'B2C',
    "optedOutAt" TIMESTAMP(3),
    "personaJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cases" (
    "id" SERIAL NOT NULL,
    "merchantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "type" "CaseType" NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "stage" "CaseStage" NOT NULL DEFAULT 'detected',
    "rootCause" "RootCause",
    "diagnosisConfidence" DOUBLE PRECISION,
    "diagnosisMethod" "DiagnosisMethod",
    "originKind" TEXT,
    "originId" TEXT,
    "originRef" TEXT,
    "deadlineAt" TIMESTAMP(3),
    "attemptsUsed" INTEGER NOT NULL DEFAULT 0,
    "attemptCap" INTEGER NOT NULL DEFAULT 4,
    "recoveredAmountPaise" INTEGER NOT NULL DEFAULT 0,
    "costPaise" INTEGER NOT NULL DEFAULT 0,
    "simRunId" TEXT,
    "simArm" "SimArm",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "case_events" (
    "id" SERIAL NOT NULL,
    "caseId" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" "EventKind" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "badgeLabel" TEXT,
    "badgeTone" TEXT,
    "body" JSONB,

    CONSTRAINT "case_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "actions" (
    "id" TEXT NOT NULL,
    "caseId" INTEGER NOT NULL,
    "kind" "ActionKind" NOT NULL,
    "channel" "Channel",
    "status" "ActionStatus" NOT NULL DEFAULT 'PLANNED',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "idempotencyKey" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "channelRef" TEXT,
    "costPaise" INTEGER NOT NULL DEFAULT 0,
    "jobId" TEXT,
    "failureReason" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_decisions" (
    "id" TEXT NOT NULL,
    "caseId" INTEGER NOT NULL,
    "actionId" TEXT,
    "verdict" "PolicyVerdict" NOT NULL,
    "checks" JSONB NOT NULL,
    "policyVersionId" TEXT NOT NULL,
    "rescheduledFor" TIMESTAMP(3),
    "evaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "evaluatedInMs" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "policy_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approvals" (
    "id" TEXT NOT NULL,
    "caseId" INTEGER NOT NULL,
    "actionId" TEXT,
    "gate" "ApprovalGate" NOT NULL,
    "headline" TEXT NOT NULL,
    "justification" JSONB NOT NULL,
    "chips" JSONB NOT NULL,
    "draft" JSONB NOT NULL,
    "candidates" JSONB,
    "concessionPaise" INTEGER NOT NULL DEFAULT 0,
    "atRiskPaise" INTEGER NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decision" "ApprovalDecision",
    "decidedBy" TEXT,
    "reason" TEXT,
    "decidedAt" TIMESTAMP(3),
    "latencySeconds" INTEGER,

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promises" (
    "id" TEXT NOT NULL,
    "caseId" INTEGER NOT NULL,
    "promisedAmountPaise" INTEGER NOT NULL,
    "promisedDate" TIMESTAMP(3) NOT NULL,
    "status" "PromiseStatus" NOT NULL DEFAULT 'PENDING',
    "followUpJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "promises_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_ledger" (
    "id" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "hash" TEXT NOT NULL,
    "prevHash" TEXT NOT NULL,
    "seed" TEXT NOT NULL,
    "actor" "LedgerActor" NOT NULL,
    "action" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "detail" TEXT NOT NULL,
    "caseId" INTEGER,
    "masked" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "payload" JSONB NOT NULL,

    CONSTRAINT "audit_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_versions" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "pack" JSONB NOT NULL,
    "hash" TEXT NOT NULL,
    "note" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policy_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sim_runs" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "seed" INTEGER NOT NULL,
    "batchSize" INTEGER NOT NULL,
    "mix" JSONB NOT NULL,
    "difficulty" TEXT NOT NULL,
    "arms" TEXT[],
    "policyVersionId" TEXT,
    "status" "SimRunStatus" NOT NULL DEFAULT 'QUEUED',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "report" JSONB,
    "headline" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sim_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sim_ground_truth" (
    "id" TEXT NOT NULL,
    "simRunId" TEXT NOT NULL,
    "caseId" INTEGER NOT NULL,
    "trueRootCause" "RootCause" NOT NULL,
    "personaSummary" TEXT NOT NULL,
    "personaJson" JSONB NOT NULL,
    "wouldSelfRecover" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "sim_ground_truth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "llm_calls" (
    "id" TEXT NOT NULL,
    "caseId" INTEGER,
    "simRunId" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "costPaise" INTEGER NOT NULL DEFAULT 0,
    "projectedCostPaise" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "llm_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "caseId" INTEGER,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "merchants_email_key" ON "merchants"("email");

-- CreateIndex
CREATE INDEX "customers_merchantId_idx" ON "customers"("merchantId");

-- CreateIndex
CREATE INDEX "cases_merchantId_stage_idx" ON "cases"("merchantId", "stage");

-- CreateIndex
CREATE INDEX "cases_merchantId_type_idx" ON "cases"("merchantId", "type");

-- CreateIndex
CREATE INDEX "cases_merchantId_rootCause_idx" ON "cases"("merchantId", "rootCause");

-- CreateIndex
CREATE INDEX "cases_simRunId_idx" ON "cases"("simRunId");

-- CreateIndex
CREATE INDEX "case_events_caseId_seq_idx" ON "case_events"("caseId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "case_events_caseId_seq_key" ON "case_events"("caseId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "actions_idempotencyKey_key" ON "actions"("idempotencyKey");

-- CreateIndex
CREATE INDEX "actions_caseId_idx" ON "actions"("caseId");

-- CreateIndex
CREATE INDEX "actions_status_scheduledFor_idx" ON "actions"("status", "scheduledFor");

-- CreateIndex
CREATE UNIQUE INDEX "policy_decisions_actionId_key" ON "policy_decisions"("actionId");

-- CreateIndex
CREATE INDEX "policy_decisions_caseId_idx" ON "policy_decisions"("caseId");

-- CreateIndex
CREATE UNIQUE INDEX "approvals_actionId_key" ON "approvals"("actionId");

-- CreateIndex
CREATE INDEX "approvals_caseId_idx" ON "approvals"("caseId");

-- CreateIndex
CREATE INDEX "approvals_decision_idx" ON "approvals"("decision");

-- CreateIndex
CREATE INDEX "promises_caseId_idx" ON "promises"("caseId");

-- CreateIndex
CREATE INDEX "promises_status_promisedDate_idx" ON "promises"("status", "promisedDate");

-- CreateIndex
CREATE INDEX "audit_ledger_chain_seq_idx" ON "audit_ledger"("chain", "seq");

-- CreateIndex
CREATE INDEX "audit_ledger_caseId_idx" ON "audit_ledger"("caseId");

-- CreateIndex
CREATE INDEX "audit_ledger_actor_idx" ON "audit_ledger"("actor");

-- CreateIndex
CREATE UNIQUE INDEX "audit_ledger_chain_seq_key" ON "audit_ledger"("chain", "seq");

-- CreateIndex
CREATE INDEX "policy_versions_merchantId_isActive_idx" ON "policy_versions"("merchantId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "policy_versions_merchantId_version_key" ON "policy_versions"("merchantId", "version");

-- CreateIndex
CREATE INDEX "sim_runs_merchantId_createdAt_idx" ON "sim_runs"("merchantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "sim_ground_truth_caseId_key" ON "sim_ground_truth"("caseId");

-- CreateIndex
CREATE INDEX "sim_ground_truth_simRunId_idx" ON "sim_ground_truth"("simRunId");

-- CreateIndex
CREATE INDEX "llm_calls_caseId_idx" ON "llm_calls"("caseId");

-- CreateIndex
CREATE INDEX "llm_calls_simRunId_idx" ON "llm_calls"("simRunId");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_eventId_key" ON "webhook_events"("eventId");

-- CreateIndex
CREATE INDEX "webhook_events_source_eventType_idx" ON "webhook_events"("source", "eventType");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cases" ADD CONSTRAINT "cases_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cases" ADD CONSTRAINT "cases_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cases" ADD CONSTRAINT "cases_simRunId_fkey" FOREIGN KEY ("simRunId") REFERENCES "sim_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "case_events" ADD CONSTRAINT "case_events_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "actions" ADD CONSTRAINT "actions_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_decisions" ADD CONSTRAINT "policy_decisions_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_decisions" ADD CONSTRAINT "policy_decisions_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "actions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_decisions" ADD CONSTRAINT "policy_decisions_policyVersionId_fkey" FOREIGN KEY ("policyVersionId") REFERENCES "policy_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "actions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promises" ADD CONSTRAINT "promises_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sim_runs" ADD CONSTRAINT "sim_runs_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sim_runs" ADD CONSTRAINT "sim_runs_policyVersionId_fkey" FOREIGN KEY ("policyVersionId") REFERENCES "policy_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sim_ground_truth" ADD CONSTRAINT "sim_ground_truth_simRunId_fkey" FOREIGN KEY ("simRunId") REFERENCES "sim_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sim_ground_truth" ADD CONSTRAINT "sim_ground_truth_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "cases"("id") ON DELETE SET NULL ON UPDATE CASCADE;
