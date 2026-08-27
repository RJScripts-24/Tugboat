-- Stage 9: the per-case manual override.
--
-- A pause is not a stage. It is reversible, it does not describe where the
-- money is, and giving it one would put "who is holding this case" into a
-- machine that describes recovery. The PolicyGate reads this column, so pausing
-- refuses outbound actions the same way an opt-out does — the difference being
-- that a human can take it back.
ALTER TABLE "cases" ADD COLUMN "pausedAt" TIMESTAMP(3);

CREATE INDEX "cases_merchantId_pausedAt_idx" ON "cases"("merchantId", "pausedAt");
