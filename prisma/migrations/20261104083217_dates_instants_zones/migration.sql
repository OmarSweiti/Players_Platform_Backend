-- Calendar dates, instants and tenant time zones (0.4.8; SR-CORE-006, UX-007,
-- ADR-0007, DB-15). A civil value — a birth date, a passport's expiry, a
-- contract's or a season's first and last day — is a DATE: the same day for
-- every reader, wherever they are. Every instant is a timestamptz(3). A tenant
-- gets a typed IANA time zone, its members' starting language and its default
-- currency, out of the untyped settings JSON; a training session gets the
-- instants it starts and ends at, and the zone its wall times are in.
--
-- The provenance of the old values is known: every row was written by the
-- application through Prisma, which stores a DateTime as UTC, or by a role whose
-- session time zone is UTC (0.4.2); and no database holds real data (OPEN-11,
-- closed 1 October 2026; ADR-0021). So an instant converts AT TIME ZONE 'UTC',
-- and a civil value keeps the UTC day it was stored on (midnight UTC, the
-- surrogate ADR-0007 replaces). 21 civil columns, 90 instants.
--
-- The backfills write tenants and training sessions, which the owner may only
-- read under forced row-level security (0.4.5): each table's FORCE is lifted for
-- its update and restored at once, inside this transaction.
--
-- Prisma runs this file as one transaction. The tables hold only synthetic data
-- (ADR-0021), so the rewrites are brief; a lock not granted within 5 s fails the
-- migration rather than queueing every request behind it.
SET LOCAL lock_timeout = '5s';
SET LOCAL TimeZone = 'UTC';

-- An IANA zone, by name, as PostgreSQL's own time zone database knows it. The
-- argument names the column; the message names the table and the column.
CREATE FUNCTION refuse_unknown_time_zone() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  zone text := to_jsonb(NEW) ->> TG_ARGV[0];
BEGIN
  IF zone IS NOT NULL AND NOT EXISTS (SELECT FROM pg_catalog.pg_timezone_names WHERE name = zone) THEN
    RAISE EXCEPTION '%.% is not an IANA time zone', TG_TABLE_NAME, TG_ARGV[0]
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION refuse_unknown_time_zone() FROM PUBLIC;

-- Every civil value becomes a DATE, every instant a timestamptz(3).
ALTER TABLE attendance
  ALTER COLUMN date TYPE DATE USING date::date,
  ALTER COLUMN created_at TYPE TIMESTAMPTZ(3) USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ(3) USING updated_at AT TIME ZONE 'UTC',
  ALTER COLUMN deleted_at TYPE TIMESTAMPTZ(3) USING deleted_at AT TIME ZONE 'UTC';

ALTER TABLE audit_logs
  ALTER COLUMN created_at TYPE TIMESTAMPTZ(3) USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN deleted_at TYPE TIMESTAMPTZ(3) USING deleted_at AT TIME ZONE 'UTC';

ALTER TABLE contract_approvals
  ALTER COLUMN responded_at TYPE TIMESTAMPTZ(3) USING responded_at AT TIME ZONE 'UTC',
  ALTER COLUMN created_at TYPE TIMESTAMPTZ(3) USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ(3) USING updated_at AT TIME ZONE 'UTC',
  ALTER COLUMN deleted_at TYPE TIMESTAMPTZ(3) USING deleted_at AT TIME ZONE 'UTC';

ALTER TABLE contract_versions
  ALTER COLUMN created_at TYPE TIMESTAMPTZ(3) USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ(3) USING updated_at AT TIME ZONE 'UTC',
  ALTER COLUMN deleted_at TYPE TIMESTAMPTZ(3) USING deleted_at AT TIME ZONE 'UTC';

ALTER TABLE contracts
  ALTER COLUMN start_date TYPE DATE USING start_date::date,
  ALTER COLUMN end_date TYPE DATE USING end_date::date,
  ALTER COLUMN signed_at TYPE TIMESTAMPTZ(3) USING signed_at AT TIME ZONE 'UTC',
  ALTER COLUMN approved_at TYPE TIMESTAMPTZ(3) USING approved_at AT TIME ZONE 'UTC',
  ALTER COLUMN expires_notified_at TYPE TIMESTAMPTZ(3) USING expires_notified_at AT TIME ZONE 'UTC',
  ALTER COLUMN termination_date TYPE DATE USING termination_date::date,
  ALTER COLUMN created_at TYPE TIMESTAMPTZ(3) USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ(3) USING updated_at AT TIME ZONE 'UTC',
  ALTER COLUMN deleted_at TYPE TIMESTAMPTZ(3) USING deleted_at AT TIME ZONE 'UTC';

ALTER TABLE conversation_members
  ALTER COLUMN last_read_at TYPE TIMESTAMPTZ(3) USING last_read_at AT TIME ZONE 'UTC',
  ALTER COLUMN created_at TYPE TIMESTAMPTZ(3) USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN deleted_at TYPE TIMESTAMPTZ(3) USING deleted_at AT TIME ZONE 'UTC';

ALTER TABLE conversations
  ALTER COLUMN last_message_at TYPE TIMESTAMPTZ(3) USING last_message_at AT TIME ZONE 'UTC',
  ALTER COLUMN created_at TYPE TIMESTAMPTZ(3) USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ(3) USING updated_at AT TIME ZONE 'UTC',
  ALTER COLUMN deleted_at TYPE TIMESTAMPTZ(3) USING deleted_at AT TIME ZONE 'UTC';

ALTER TABLE documents
  ALTER COLUMN created_at TYPE TIMESTAMPTZ(3) USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ(3) USING updated_at AT TIME ZONE 'UTC',
  ALTER COLUMN deleted_at TYPE TIMESTAMPTZ(3) USING deleted_at AT TIME ZONE 'UTC';

ALTER TABLE enrollments
  ALTER COLUMN paid_at TYPE TIMESTAMPTZ(3) USING paid_at AT TIME ZONE 'UTC',
  ALTER COLUMN created_at TYPE TIMESTAMPTZ(3) USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ(3) USING updated_at AT TIME ZONE 'UTC',
  ALTER COLUMN deleted_at TYPE TIMESTAMPTZ(3) USING deleted_at AT TIME ZONE 'UTC';

ALTER TABLE legal_notes
  ALTER COLUMN created_at TYPE TIMESTAMPTZ(3) USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ(3) USING updated_at AT TIME ZONE 'UTC',
  ALTER COLUMN deleted_at TYPE TIMESTAMPTZ(3) USING deleted_at AT TIME ZONE 'UTC';

ALTER TABLE legal_tickets
  ALTER COLUMN resolved_at TYPE TIMESTAMPTZ(3) USING resolved_at AT TIME ZONE 'UTC',
  ALTER COLUMN closed_at TYPE TIMESTAMPTZ(3) USING closed_at AT TIME ZONE 'UTC',
  ALTER COLUMN due_date TYPE DATE USING due_date::date,
  ALTER COLUMN created_at TYPE TIMESTAMPTZ(3) USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ(3) USING updated_at AT TIME ZONE 'UTC',
  ALTER COLUMN deleted_at TYPE TIMESTAMPTZ(3) USING deleted_at AT TIME ZONE 'UTC';

ALTER TABLE medical_records
  ALTER COLUMN injury_date TYPE DATE USING injury_date::date,
  ALTER COLUMN recovery_date TYPE DATE USING recovery_date::date,
  ALTER COLUMN return_to_play_date TYPE DATE USING return_to_play_date::date,
  ALTER COLUMN created_at TYPE TIMESTAMPTZ(3) USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ(3) USING updated_at AT TIME ZONE 'UTC',
  ALTER COLUMN deleted_at TYPE TIMESTAMPTZ(3) USING deleted_at AT TIME ZONE 'UTC';

ALTER TABLE messages
  ALTER COLUMN edited_at TYPE TIMESTAMPTZ(3) USING edited_at AT TIME ZONE 'UTC',
  ALTER COLUMN deleted_at TYPE TIMESTAMPTZ(3) USING deleted_at AT TIME ZONE 'UTC',
  ALTER COLUMN created_at TYPE TIMESTAMPTZ(3) USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ(3) USING updated_at AT TIME ZONE 'UTC';

ALTER TABLE notifications
  ALTER COLUMN read_at TYPE TIMESTAMPTZ(3) USING read_at AT TIME ZONE 'UTC',
  ALTER COLUMN created_at TYPE TIMESTAMPTZ(3) USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ(3) USING updated_at AT TIME ZONE 'UTC',
  ALTER COLUMN deleted_at TYPE TIMESTAMPTZ(3) USING deleted_at AT TIME ZONE 'UTC';

ALTER TABLE performance_records
  ALTER COLUMN match_date TYPE DATE USING match_date::date,
  ALTER COLUMN created_at TYPE TIMESTAMPTZ(3) USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ(3) USING updated_at AT TIME ZONE 'UTC',
  ALTER COLUMN deleted_at TYPE TIMESTAMPTZ(3) USING deleted_at AT TIME ZONE 'UTC';

ALTER TABLE permissions
  ALTER COLUMN created_at TYPE TIMESTAMPTZ(3) USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ(3) USING updated_at AT TIME ZONE 'UTC';

ALTER TABLE player_media
  ALTER COLUMN created_at TYPE TIMESTAMPTZ(3) USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ(3) USING updated_at AT TIME ZONE 'UTC',
  ALTER COLUMN deleted_at TYPE TIMESTAMPTZ(3) USING deleted_at AT TIME ZONE 'UTC';

ALTER TABLE player_watchlists
  ALTER COLUMN created_at TYPE TIMESTAMPTZ(3) USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ(3) USING updated_at AT TIME ZONE 'UTC';

ALTER TABLE players
  ALTER COLUMN date_of_birth TYPE DATE USING date_of_birth::date,
  ALTER COLUMN passport_expiry TYPE DATE USING passport_expiry::date,
  ALTER COLUMN created_at TYPE TIMESTAMPTZ(3) USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ(3) USING updated_at AT TIME ZONE 'UTC',
  ALTER COLUMN deleted_at TYPE TIMESTAMPTZ(3) USING deleted_at AT TIME ZONE 'UTC';

ALTER TABLE ratings
  ALTER COLUMN created_at TYPE TIMESTAMPTZ(3) USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ(3) USING updated_at AT TIME ZONE 'UTC',
  ALTER COLUMN deleted_at TYPE TIMESTAMPTZ(3) USING deleted_at AT TIME ZONE 'UTC';

ALTER TABLE role_permissions
  ALTER COLUMN created_at TYPE TIMESTAMPTZ(3) USING created_at AT TIME ZONE 'UTC';

ALTER TABLE scouting_assignments
  ALTER COLUMN due_date TYPE DATE USING due_date::date,
  ALTER COLUMN created_at TYPE TIMESTAMPTZ(3) USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ(3) USING updated_at AT TIME ZONE 'UTC';

ALTER TABLE scouting_reports
  ALTER COLUMN report_date TYPE DATE USING report_date::date,
  ALTER COLUMN created_at TYPE TIMESTAMPTZ(3) USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ(3) USING updated_at AT TIME ZONE 'UTC',
  ALTER COLUMN deleted_at TYPE TIMESTAMPTZ(3) USING deleted_at AT TIME ZONE 'UTC';

ALTER TABLE seasons
  ALTER COLUMN start_date TYPE DATE USING start_date::date,
  ALTER COLUMN end_date TYPE DATE USING end_date::date,
  ALTER COLUMN created_at TYPE TIMESTAMPTZ(3) USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ(3) USING updated_at AT TIME ZONE 'UTC',
  ALTER COLUMN deleted_at TYPE TIMESTAMPTZ(3) USING deleted_at AT TIME ZONE 'UTC';

ALTER TABLE tenants
  ALTER COLUMN created_at TYPE TIMESTAMPTZ(3) USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ(3) USING updated_at AT TIME ZONE 'UTC';

ALTER TABLE training_sessions
  ALTER COLUMN date TYPE DATE USING date::date,
  ALTER COLUMN created_at TYPE TIMESTAMPTZ(3) USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ(3) USING updated_at AT TIME ZONE 'UTC',
  ALTER COLUMN deleted_at TYPE TIMESTAMPTZ(3) USING deleted_at AT TIME ZONE 'UTC';

ALTER TABLE trainings
  ALTER COLUMN start_date TYPE DATE USING start_date::date,
  ALTER COLUMN end_date TYPE DATE USING end_date::date,
  ALTER COLUMN created_at TYPE TIMESTAMPTZ(3) USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ(3) USING updated_at AT TIME ZONE 'UTC',
  ALTER COLUMN deleted_at TYPE TIMESTAMPTZ(3) USING deleted_at AT TIME ZONE 'UTC';

ALTER TABLE treatment_sessions
  ALTER COLUMN session_date TYPE DATE USING session_date::date,
  ALTER COLUMN created_at TYPE TIMESTAMPTZ(3) USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ(3) USING updated_at AT TIME ZONE 'UTC';

ALTER TABLE users
  ALTER COLUMN last_login_at TYPE TIMESTAMPTZ(3) USING last_login_at AT TIME ZONE 'UTC',
  ALTER COLUMN created_at TYPE TIMESTAMPTZ(3) USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE TIMESTAMPTZ(3) USING updated_at AT TIME ZONE 'UTC',
  ALTER COLUMN deleted_at TYPE TIMESTAMPTZ(3) USING deleted_at AT TIME ZONE 'UTC',
  ALTER COLUMN employment_end_date TYPE DATE USING employment_end_date::date,
  ALTER COLUMN employment_start_date TYPE DATE USING employment_start_date::date;

-- The tenant's typed settings. A value the settings JSON already held moves
-- across only if it is valid; an invalid one stops the migration rather than
-- being dropped or replaced.
CREATE TYPE locale AS ENUM ('ar', 'en');

DO $$
BEGIN
  IF EXISTS (
    SELECT FROM tenants t
    WHERE (t.settings ? 'timezone'
           AND NOT EXISTS (SELECT FROM pg_catalog.pg_timezone_names z WHERE z.name = t.settings ->> 'timezone'))
       OR (coalesce(t.settings ->> 'defaultLocale', t.settings ->> 'locale') NOT IN ('ar', 'en'))
       OR (coalesce(t.settings ->> 'defaultCurrency', t.settings ->> 'currency') IS NOT NULL
           AND NOT EXISTS (SELECT FROM currency_definitions c
                           WHERE c.code = coalesce(t.settings ->> 'defaultCurrency', t.settings ->> 'currency')))
  ) THEN
    RAISE EXCEPTION 'a tenant''s settings hold a time zone, locale or currency that is not valid'
      USING HINT = 'correct the tenant''s settings JSON (an IANA zone, ar or en, an ISO 4217 code), then migrate again';
  END IF;
END
$$;

ALTER TABLE tenants
  ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC',
  ADD COLUMN default_locale locale NOT NULL DEFAULT 'ar',
  ADD COLUMN default_currency CHAR(3) NOT NULL DEFAULT 'JOD',
  ADD CONSTRAINT tenants_default_currency_fkey FOREIGN KEY (default_currency)
    REFERENCES currency_definitions (code) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE tenants NO FORCE ROW LEVEL SECURITY;
UPDATE tenants t SET
  timezone = coalesce(t.settings ->> 'timezone', t.timezone),
  default_locale = coalesce(t.settings ->> 'defaultLocale', t.settings ->> 'locale', t.default_locale::text)::locale,
  default_currency = coalesce(t.settings ->> 'defaultCurrency', t.settings ->> 'currency', t.default_currency),
  settings = nullif(t.settings - 'timezone' - 'defaultLocale' - 'locale' - 'defaultCurrency' - 'currency', '{}'::jsonb)
WHERE t.settings ?| ARRAY['timezone', 'defaultLocale', 'locale', 'defaultCurrency', 'currency'];
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;

-- The settings JSON no longer holds them.
ALTER TABLE tenants ADD CONSTRAINT tenants_settings_check
  CHECK (NOT (settings ?| ARRAY['timezone', 'defaultLocale', 'locale', 'defaultCurrency', 'currency']));

CREATE TRIGGER tenants_timezone_is_iana BEFORE INSERT OR UPDATE OF timezone ON tenants
  FOR EACH ROW EXECUTE FUNCTION refuse_unknown_time_zone('timezone');

-- A session's start and end: its day and its wall times, read in its tenant's
-- zone, the zone the agency entered them in. A session without a time keeps
-- none.
ALTER TABLE training_sessions
  ADD COLUMN starts_at TIMESTAMPTZ(3),
  ADD COLUMN ends_at TIMESTAMPTZ(3),
  ADD COLUMN time_zone TEXT;

ALTER TABLE training_sessions NO FORCE ROW LEVEL SECURITY;
UPDATE training_sessions s SET
  time_zone = t.timezone,
  starts_at = (s.date + s.start_time::time) AT TIME ZONE t.timezone,
  ends_at = (s.date + s.end_time::time) AT TIME ZONE t.timezone
FROM tenants t
WHERE t.id = s.tenant_id;
ALTER TABLE training_sessions FORCE ROW LEVEL SECURITY;

ALTER TABLE training_sessions
  ALTER COLUMN time_zone SET NOT NULL,
  DROP COLUMN start_time,
  DROP COLUMN end_time;

CREATE TRIGGER training_sessions_time_zone_is_iana BEFORE INSERT OR UPDATE OF time_zone ON training_sessions
  FOR EACH ROW EXECUTE FUNCTION refuse_unknown_time_zone('time_zone');
