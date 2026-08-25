-- Append-only enforcement for the audit ledger (ADR-9).
--
-- The claim "the ledger is tamper-evident" rests on two things: the hash chain,
-- which makes an edit detectable, and these grants, which make an edit
-- impossible for the process that writes the log. Hash chaining alone only
-- proves that whoever rewrote a row failed to rewrite every row after it.
--
-- STATUS: written, NOT yet applied. Neon's free tier issues a single role
-- (neondb_owner) that both migrates and runs the app, so there is no separate
-- app role to restrict. Applying this requires creating that role first, which
-- is a deployment step rather than a code one. Stated plainly here rather than
-- claimed as done -- see docs/BUILD-NOTES.md.

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

-- Verification: this must fail with "permission denied for table audit_ledger".
--   SET ROLE tugboat_app;
--   UPDATE audit_ledger SET detail = 'tampered' WHERE seq = 1;
