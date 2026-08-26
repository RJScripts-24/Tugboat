-- Append-only enforcement for the audit ledger (ADR-9).
--
-- The claim "the ledger is tamper-evident" rests on three things, and it is
-- worth being exact about which of them are in place:
--
--   1. The hash chain, which makes an edit *detectable*. In place since Stage 7
--      (src/audit), verified in the browser and by POST /audit/verify-chain.
--   2. A database trigger, which makes an ordinary edit *fail*. In place since
--      Stage 7 — see the migration
--      20260825170500_stage7_audit_ledger_chain/migration.sql. It needs no
--      second role, so it works on Neon's free tier, and it stops every write
--      the application could make: an ORM update, a stray UPDATE in a console,
--      a statement injected through the app.
--   3. These grants, which make an edit impossible *even for a superuser
--      session that drops the trigger*, because the app role would no longer
--      hold the privilege to re-create it or to write. STILL NOT APPLIED.
--
-- STATUS OF THIS FILE: written, NOT yet applied. Neon's free tier issues a
-- single role (neondb_owner) that both migrates and serves the app, so there is
-- no separate app role to restrict. Applying this requires creating that role
-- first, which is a deployment step rather than a code one. Stated plainly here
-- rather than claimed as done -- see docs/BUILD-NOTES.md, B-5.
--
-- What changed at Stage 7: mechanism 2 closed most of the gap this file used to
-- describe on its own. The honest summary for a panelist is "chained and
-- trigger-enforced today; role-separated at deployment, and here is the SQL".

-- 1. A role for the running application, distinct from the migration owner.
CREATE ROLE tugboat_app WITH LOGIN PASSWORD :'app_password';

-- 2. Ordinary tables: full data access, no schema rights.
GRANT USAGE ON SCHEMA public TO tugboat_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tugboat_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO tugboat_app;

-- 3. The ledger is the exception: it may be added to and read, never changed.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_ledger FROM tugboat_app;
GRANT SELECT, INSERT ON TABLE audit_ledger TO tugboat_app;

-- 4. Same rule for anything created by future migrations.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tugboat_app;

-- 5. The trigger's maintenance bypass exists so the seed and the test suite can
--    rebuild their own fixtures. The application role has no business setting
--    it, and once role separation is in place it should not be able to.
REVOKE ALL ON FUNCTION audit_ledger_append_only() FROM tugboat_app;

-- Verification: each of these must fail with "permission denied for table
-- audit_ledger", and the first must fail even before the grants are applied,
-- because the trigger refuses it regardless of role.
--   UPDATE audit_ledger SET detail = 'tampered' WHERE seq = 1;
--   SET ROLE tugboat_app;
--   UPDATE audit_ledger SET detail = 'tampered' WHERE seq = 1;
--   DELETE FROM audit_ledger WHERE seq = 1;
