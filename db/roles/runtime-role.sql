-- Restricted runtime role (security audit F15). Run once as the database owner / admin user,
-- AFTER `pnpm db:migrate` has created the tables, replacing the password placeholder:
--
--   psql "$MIGRATION_DATABASE_URL" -v app_password="'<strong generated password>'" -f db/roles/runtime-role.sql
--
-- Then point the running application at the new role:
--   DATABASE_URL           = postgresql://invox_app:<password>@<host>:<port>/<db>?sslmode=require   (application)
--   MIGRATION_DATABASE_URL = the existing owner connection string                                   (release job only)
--
-- The runtime role can read and write business rows but cannot create or alter tables, create roles,
-- disable triggers (so append-only audit/ledger protections hold) or read other schemas.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'invox_app') THEN
    CREATE ROLE invox_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;
ALTER ROLE invox_app WITH LOGIN PASSWORD :app_password;
ALTER ROLE invox_app SET statement_timeout = '15s';
ALTER ROLE invox_app SET idle_in_transaction_session_timeout = '30s';

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM invox_app;
GRANT USAGE ON SCHEMA public TO invox_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO invox_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO invox_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO invox_app;
-- Migration bookkeeping is the release job's business only.
REVOKE INSERT, UPDATE, DELETE ON app_migrations FROM invox_app;

-- Tables and sequences created by future migrations (run by this owner) are granted automatically.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO invox_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO invox_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO invox_app;
