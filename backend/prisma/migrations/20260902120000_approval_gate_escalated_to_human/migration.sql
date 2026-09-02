-- A fifth approval gate: a case a human is holding.
--
-- Escalating a case has always moved it to `escalated` and stopped the agent,
-- but nothing ever asked whether to carry on — so the queue a merchant reads
-- was empty while three cases sat waiting on them (D-151).
ALTER TYPE "ApprovalGate" ADD VALUE IF NOT EXISTS 'escalated_to_human';
