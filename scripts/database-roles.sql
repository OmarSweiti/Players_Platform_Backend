-- The database roles (0.4.2; the umbrella's docs/reference/database.md, "Database
-- identities, grants and RLS"):
--
--   sadara_owner     NOLOGIN. Owns the database's schemas and everything in them.
--   sadara_migrator  Logs in only to migrate, and acts as sadara_owner when it does,
--                    so every object it creates belongs to the owner.
--   sadara_app       The runtime role: the API, the worker and the tests connect as
--                    it. Data only (DML) — no ownership, no DDL, never past
--                    row-level security — and its work is bounded in time (DB-52).
--   sadara_registry  The worker's discovery role (0.7.6): it finds which tenants
--                    are active and nothing else. The migration that grants it
--                    reads only tenant_directory's id and is_active; it logs in
--                    only where SADARA_REGISTRY_PASSWORD is given (the local
--                    stack, and the tests that run the worker), and exists
--                    without a login elsewhere, so that the grant always applies.
--
-- Run by a superuser through psql, connected to the database it provisions:
--
--   SADARA_MIGRATOR_PASSWORD=… SADARA_APP_PASSWORD=… psql -d <database> -f scripts/database-roles.sql
--
-- The roles are the cluster's: created on the first run, and their attributes,
-- passwords and settings applied again on every run. The ownership and grants are
-- the connected database's, so a cluster with two databases (the local stack's
-- sadara and sadara_test) runs it in each. The passwords come from the
-- environment, never from this file. The umbrella's local stack runs it
-- (infra/postgres/init/10-roles.sql), and so do CI and `just migrations`: one
-- definition everywhere, and test/db/roles.integration-spec.ts proves the result.
\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning; -- a second run re-grants what exists: no news

\getenv migrator_password SADARA_MIGRATOR_PASSWORD
\getenv app_password SADARA_APP_PASSWORD
SELECT :{?migrator_password} AND :{?app_password} AS passwords_set \gset
\if :passwords_set
\else
DO $$ BEGIN RAISE EXCEPTION 'database-roles: set SADARA_MIGRATOR_PASSWORD and SADARA_APP_PASSWORD; the passwords come from the environment'; END $$;
\endif
SELECT length(:'migrator_password') > 0 AND length(:'app_password') > 0 AS passwords_given \gset
\if :passwords_given
\else
DO $$ BEGIN RAISE EXCEPTION 'database-roles: SADARA_MIGRATOR_PASSWORD and SADARA_APP_PASSWORD must not be empty'; END $$;
\endif

-- The registry role's password is optional: without it the role cannot log in.
\getenv registry_password SADARA_REGISTRY_PASSWORD
SELECT :{?registry_password} AS registry_set \gset
\if :registry_set
SELECT length(:'registry_password') > 0 AS registry_login \gset
\else
\set registry_login false
\endif

-- ── The roles: the cluster's ─────────────────────────────────────────────────
SELECT NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sadara_owner') AS missing \gset
\if :missing
CREATE ROLE sadara_owner;
\endif
SELECT NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sadara_migrator') AS missing \gset
\if :missing
CREATE ROLE sadara_migrator;
\endif
SELECT NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sadara_app') AS missing \gset
\if :missing
CREATE ROLE sadara_app;
\endif
SELECT NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sadara_registry') AS missing \gset
\if :missing
CREATE ROLE sadara_registry;
\endif

ALTER ROLE sadara_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE sadara_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT
  PASSWORD :'migrator_password';
ALTER ROLE sadara_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT
  PASSWORD :'app_password';
\if :registry_login
ALTER ROLE sadara_registry LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT
  PASSWORD :'registry_password';
\else
ALTER ROLE sadara_registry NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT
  PASSWORD NULL;
\endif

-- The migrator may become the owner, and does at every login: what it creates is
-- the owner's. It inherits none of the owner's rights without that switch.
GRANT sadara_owner TO sadara_migrator WITH INHERIT FALSE, SET TRUE;
ALTER ROLE sadara_migrator SET role = 'sadara_owner';

-- The runtime role's work is bounded (DB-52). A job that needs longer raises its
-- own limit with SET LOCAL, inside its transaction, where a reviewer sees it.
ALTER ROLE sadara_app SET statement_timeout = '15s';
ALTER ROLE sadara_app SET lock_timeout = '5s';
ALTER ROLE sadara_app SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE sadara_app SET timezone = 'UTC';
-- The registry role reads one small view: a second is more than it needs.
ALTER ROLE sadara_registry SET statement_timeout = '5s';
ALTER ROLE sadara_registry SET lock_timeout = '2s';
ALTER ROLE sadara_registry SET idle_in_transaction_session_timeout = '10s';

-- ── The connected database: its owner and its grants ─────────────────────────
SELECT current_database() AS database \gset
ALTER DATABASE :"database" OWNER TO sadara_owner;
REVOKE ALL ON DATABASE :"database" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"database" TO sadara_migrator, sadara_app, sadara_registry;

-- The public schema belongs to the database's owner (pg_database_owner); nobody
-- else creates in it, and the runtime role only reaches into it.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO sadara_app;

-- Whatever the owner creates from now on, through the migrator, the runtime role
-- may use for data: schemas to reach into, tables to read and write, sequences
-- to draw from. Never TRUNCATE, REFERENCES or TRIGGER, and never to grant on.
ALTER DEFAULT PRIVILEGES FOR ROLE sadara_owner GRANT USAGE ON SCHEMAS TO sadara_app;
ALTER DEFAULT PRIVILEGES FOR ROLE sadara_owner GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sadara_app;
ALTER DEFAULT PRIVILEGES FOR ROLE sadara_owner GRANT USAGE, SELECT ON SEQUENCES TO sadara_app;

-- The registry role gets no default privilege: its one grant is a migration's
-- (…_registry_role), on tenant_directory's id and is_active alone.

\echo database-roles: sadara_owner, sadara_migrator, sadara_app and sadara_registry provisioned for :database
