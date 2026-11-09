-- Audit evidence is append-only (0.7.1; SR-AUD-005, SR-DB-009, BR-RULE-05,
-- DB-04). audit_logs was an ordinary table: the runtime role could change and
-- remove its rows, and a soft delete (deleted_at) could hide one. From here:
--   * the runtime role may insert and read its tenant's rows (row-level
--     security, 0.4.5) and nothing more: UPDATE, DELETE and TRUNCATE are
--     revoked;
--   * triggers refuse UPDATE and DELETE row by row, and TRUNCATE, which fires
--     no row trigger, by statement — for every role, the owner included, and
--     no setting lifts them. Nothing is purged until a retention path is
--     designed and approved. Only a role that may alter the table could drop
--     a trigger: that is a reviewed migration's, and the owner's compromise is
--     outside this guarantee (docs/reference/database.md);
--   * each row gains its typed columns: eventId (UUIDv7), the actor's type
--     and snapshot (a member's role and session, or the job), requestId,
--     reason, outcome and the payload's schemaVersion; deleted_at goes.
--
-- An archived audit row stops the migration. It is evidence: never undeleted
-- or erased here (just preflight lists it as deleted_audit_row); the owner
-- decides, and a restricted report keeps what it held, before this migrates.
--
-- The rows from before 0.7.1: an eventId stamped with the row's own
-- created_at; actorType USER where a member is named, SYSTEM otherwise; no
-- snapshot, request or reason, which nothing recorded; outcome SUCCEEDED, as
-- each recorded a change that took effect; schemaVersion 1.
--
-- Prisma runs this file as one transaction. The backfill writes audit_logs,
-- which the owner may only read under forced row-level security (0.4.5), so
-- FORCE is lifted for it and restored at once, inside this transaction and
-- before the triggers exist. The tables hold only synthetic data (ADR-0021);
-- a lock not granted within 5 s fails the migration rather than queueing every
-- request behind it.
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF EXISTS (SELECT FROM audit_logs WHERE deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'an audit row is archived: audit evidence is never undeleted or erased'
      USING HINT = 'just preflight lists it (deleted_audit_row); the owner decides, and a restricted report keeps what it held, before this migrates';
  END IF;
END
$$;

-- CreateEnum
CREATE TYPE "audit_actor_type" AS ENUM ('USER', 'SYSTEM', 'PLATFORM');

-- CreateEnum
CREATE TYPE "audit_outcome" AS ENUM ('SUCCEEDED', 'DENIED');

-- AlterTable: the columns, empty, then filled for the rows from before.
ALTER TABLE "audit_logs" DROP COLUMN "deleted_at",
ADD COLUMN     "actor_job" VARCHAR(100),
ADD COLUMN     "actor_role" "user_role",
ADD COLUMN     "actor_session_id" UUID,
ADD COLUMN     "actor_type" "audit_actor_type",
ADD COLUMN     "event_id" UUID,
ADD COLUMN     "outcome" "audit_outcome",
ADD COLUMN     "reason" VARCHAR(500),
ADD COLUMN     "request_id" VARCHAR(128),
ADD COLUMN     "schema_version" SMALLINT;

ALTER TABLE audit_logs NO FORCE ROW LEVEL SECURITY;
UPDATE audit_logs SET
  event_id = uuidv7(created_at - clock_timestamp()),
  actor_type = CASE WHEN user_id IS NULL THEN 'SYSTEM' ELSE 'USER' END::audit_actor_type,
  outcome = 'SUCCEEDED',
  schema_version = 1;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;

ALTER TABLE "audit_logs"
  ALTER COLUMN "actor_type" SET NOT NULL,
  ALTER COLUMN "event_id" SET NOT NULL,
  ALTER COLUMN "outcome" SET NOT NULL,
  ALTER COLUMN "schema_version" SET NOT NULL;

-- CreateIndex: unique in its tenant, led by tenant_id as every index on a
-- tenant's table is.
CREATE UNIQUE INDEX "audit_logs_tenant_id_event_id_key" ON "audit_logs"("tenant_id", "event_id");

-- A member is named exactly when a member acted; a member's role and session
-- only for a member, and a job only for the system. A payload's version is 1
-- or more. (Hand-written: Prisma's drift check sees no CHECK.)
ALTER TABLE audit_logs
  ADD CONSTRAINT audit_logs_actor_check CHECK (
    (actor_type = 'USER') = (user_id IS NOT NULL)
    AND (actor_type = 'USER' OR (actor_role IS NULL AND actor_session_id IS NULL))
    AND (actor_type = 'SYSTEM' OR actor_job IS NULL)
  ),
  ADD CONSTRAINT audit_logs_schema_version_check CHECK (schema_version >= 1);

-- The runtime role appends and reads; it never changes or removes.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM sadara_app;

-- And no role does, the owner included. The function serves every table of
-- evidence: security events, contract versions, approval decisions and
-- signature events take it in their own migrations.
CREATE FUNCTION reject_evidence_mutation() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'evidence is append-only: % on % is refused', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END
$$;
REVOKE ALL ON FUNCTION reject_evidence_mutation() FROM PUBLIC;

CREATE TRIGGER audit_logs_no_update_delete BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation();
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation();
