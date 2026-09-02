-- A case put back to the start by a human (D-157).
--
-- The gate counts every action-derived bound from this instant when it is set,
-- so a restart resets the channel caps, the cool-down and the re-presentation
-- count without deleting a single row of what actually happened.
ALTER TABLE "cases" ADD COLUMN IF NOT EXISTS "restartedAt" TIMESTAMP(3);
