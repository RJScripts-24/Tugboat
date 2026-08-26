-- Stage 7 — the audit ledger becomes writable, and un-rewritable.
--
-- Hand-authored rather than generated, because the trigger at the bottom is not
-- something Prisma's schema language can express and it is the half of ADR-9
-- that a hash chain cannot provide on its own: chaining makes an edit
-- *detectable*, this makes an ordinary edit *fail*.

-- 1. Tenancy, and the server's parallel SHA-256 chain (D-73).
--    Safe as NOT NULL without a default: nothing has written to this table yet
--    (Stage 7 is its first writer), which was checked before this was written.
ALTER TABLE "audit_ledger" ADD COLUMN "merchantId" TEXT NOT NULL;
ALTER TABLE "audit_ledger" ADD COLUMN "sha256" TEXT NOT NULL DEFAULT '';
ALTER TABLE "audit_ledger" ADD COLUMN "prevSha256" TEXT NOT NULL DEFAULT '';

-- 2. A chain is unique *inside* a merchant, so two tenants can each own a chain
--    called "policy" without colliding on its sequence numbers.
DROP INDEX "audit_ledger_chain_seq_key";
CREATE UNIQUE INDEX "audit_ledger_merchantId_chain_seq_key" ON "audit_ledger"("merchantId", "chain", "seq");
CREATE INDEX "audit_ledger_merchantId_at_idx" ON "audit_ledger"("merchantId", "at");

-- 3. Append-only, enforced by the database itself.
--
--    ADR-9 asks for an application role holding INSERT and SELECT and nothing
--    else. Neon's free tier issues one role that both migrates and serves the
--    app, so there is no lesser role to restrict (B-5) — but a trigger needs no
--    second role and stops every ordinary write: an ORM update, a stray UPDATE
--    in a console, a statement injected through the app. It does not stop an
--    owner who deliberately drops the trigger, which is exactly why the grants
--    in prisma/sql/audit-ledger-grants.sql remain the deployment step.
--
--    The escape hatch is a session variable, and it exists so a test suite can
--    clean up after itself. No file under backend/src sets it, which is not a
--    convention but an assertion — see audit/architecture.spec.ts.
CREATE OR REPLACE FUNCTION audit_ledger_append_only() RETURNS trigger AS $$
BEGIN
  IF current_setting('tugboat.ledger_maintenance', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  RAISE EXCEPTION 'audit_ledger is append-only: % is not permitted on a written row', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_ledger_no_rewrite
  BEFORE UPDATE OR DELETE ON "audit_ledger"
  FOR EACH ROW EXECUTE FUNCTION audit_ledger_append_only();
