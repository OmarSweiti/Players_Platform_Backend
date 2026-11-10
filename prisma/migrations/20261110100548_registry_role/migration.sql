-- The registry role's one grant (0.7.6; SYS-TEN-006, docs/reference/database.md,
-- "TenantRegistry"). The worker finds its work without a privileged client: it
-- lists the active tenants as sadara_registry, which may read tenant_directory's
-- id and is_active and nothing else — no slug, no domain, no table — and then
-- claims each tenant's events in that tenant's own transaction, as the runtime
-- role, under row-level security.
--
-- The role is the cluster's, created by scripts/database-roles.sql, which the
-- local stack, CI and `just migrations` run before migrating: a migration
-- cannot create one, since the migrator holds no CREATEROLE. Its absence stops
-- this migration rather than leave the grant unmade. The schema is the one this
-- migration runs in, so that a test run's own schema grants it too.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sadara_registry') THEN
    RAISE EXCEPTION 'the registry role sadara_registry does not exist'
      USING HINT = 'run scripts/database-roles.sql (the umbrella''s just up applies it), then migrate';
  END IF;
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO sadara_registry', current_schema());
END
$$;

GRANT SELECT (id, is_active) ON tenant_directory TO sadara_registry;
