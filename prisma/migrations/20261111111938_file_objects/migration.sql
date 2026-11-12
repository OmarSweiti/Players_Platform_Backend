-- File objects and upload sessions (0.8.2; ADR-0009, SR-DOC-001, SR-DB-008).
-- A file is a row here, never a URL: its upload lands in quarantine by a key
-- the storage port's builder made (0.8.1); completion pins the exact
-- quarantined version (0.8.3); the scan reads that version; a clean file is
-- promoted to an immutable object, its version and SHA-256 recorded (0.8.4).
-- What a file is for is its owner's typed binding, built with each domain:
-- an upload session names its owner only as a declared intent, never joined
-- (DB-69).
--
-- Both are tenant-owned, under forced row-level security like every tenant
-- table, and kept: a file is purged by marking it (1.3.4), and no cascade
-- deletes a cloud object. Once pinned, a file's identity — its keys, its
-- versions, its hash, its size, its creator — never changes: a trigger
-- refuses it.
--
-- New, empty tables: nothing to preflight.

-- CreateEnum
CREATE TYPE "file_status" AS ENUM ('CREATED', 'UPLOADING', 'UPLOADED', 'SCANNING', 'PROCESSING', 'READY', 'FAILED', 'REJECTED', 'ABORTED');

-- CreateEnum
CREATE TYPE "scan_verdict" AS ENUM ('PENDING', 'CLEAN', 'INFECTED', 'ERROR');

-- CreateEnum
CREATE TYPE "file_classification" AS ENUM ('OPERATIONAL', 'IDENTITY', 'MEDICAL', 'LEGAL_INTERNAL', 'FINANCE', 'MINOR_POLICY');

-- CreateTable
CREATE TABLE "file_objects" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "quarantine_key" VARCHAR(160) NOT NULL,
    "quarantine_version_id" VARCHAR(1024),
    "object_key" VARCHAR(160),
    "object_version_id" VARCHAR(1024),
    "sha256" BYTEA,
    "size_bytes" BIGINT NOT NULL,
    "mime_type" VARCHAR(127) NOT NULL,
    "original_name" VARCHAR(255) NOT NULL,
    "status" "file_status" NOT NULL DEFAULT 'CREATED',
    "scan_verdict" "scan_verdict" NOT NULL DEFAULT 'PENDING',
    "classification" "file_classification" NOT NULL,
    "retention_class" VARCHAR(60) NOT NULL DEFAULT 'UNCLASSIFIED',
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalized_at" TIMESTAMPTZ(3),
    "purged_at" TIMESTAMPTZ(3),

    CONSTRAINT "file_objects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upload_sessions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "file_object_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "declared_size" BIGINT NOT NULL,
    "declared_type" VARCHAR(127) NOT NULL,
    "owner_kind" VARCHAR(60) NOT NULL,
    "owner_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "finalized_at" TIMESTAMPTZ(3),
    "aborted_at" TIMESTAMPTZ(3),
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "upload_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "file_objects_tenant_id_status_idx" ON "file_objects"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "file_objects_tenant_id_created_by_id_idx" ON "file_objects"("tenant_id", "created_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "file_objects_id_tenant_id_key" ON "file_objects"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "file_objects_tenant_id_quarantine_key_key" ON "file_objects"("tenant_id", "quarantine_key");

-- CreateIndex
CREATE UNIQUE INDEX "file_objects_tenant_id_object_key_key" ON "file_objects"("tenant_id", "object_key");

-- CreateIndex
CREATE INDEX "upload_sessions_tenant_id_created_by_id_idx" ON "upload_sessions"("tenant_id", "created_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "upload_sessions_id_tenant_id_key" ON "upload_sessions"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "upload_sessions_tenant_id_file_object_id_key" ON "upload_sessions"("tenant_id", "file_object_id");

-- AddForeignKey
ALTER TABLE "file_objects" ADD CONSTRAINT "file_objects_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "file_objects" ADD CONSTRAINT "file_objects_created_by_id_tenant_id_fkey" FOREIGN KEY ("created_by_id", "tenant_id") REFERENCES "users"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_file_object_id_tenant_id_fkey" FOREIGN KEY ("file_object_id", "tenant_id") REFERENCES "file_objects"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_created_by_id_tenant_id_fkey" FOREIGN KEY ("created_by_id", "tenant_id") REFERENCES "users"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- What a file may hold (hand-written; test/files/files.integration-spec.ts).
-- Its keys are its builder's, under its own tenant: quarantine, then objects
-- (so a key is never a URL or a name); an object's key and version come
-- together; a version id is printable and bounded; the hash is SHA-256's
-- length; the size is positive; the type is `type/subtype`, lower case; the
-- name has no control character; the retention class is an upper-case code.
-- And its state: pinned from UPLOADED on; promoted only when clean; READY only
-- clean, promoted and hashed, and then finalized; INFECTED only REJECTED.
ALTER TABLE file_objects
  ADD CONSTRAINT file_objects_quarantine_key_check
    CHECK (quarantine_key ~ ('^tenants/' || tenant_id::text
      || '/quarantine/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')),
  ADD CONSTRAINT file_objects_object_key_check
    CHECK (object_key ~ ('^tenants/' || tenant_id::text
      || '/objects/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')),
  ADD CONSTRAINT file_objects_object_check
    CHECK ((object_key IS NULL) = (object_version_id IS NULL)),
  ADD CONSTRAINT file_objects_version_ids_check
    CHECK (quarantine_version_id ~ '^[!-~]+$' AND object_version_id ~ '^[!-~]+$'),
  ADD CONSTRAINT file_objects_sha256_check
    CHECK (octet_length(sha256) = 32),
  ADD CONSTRAINT file_objects_size_bytes_check
    CHECK (size_bytes > 0),
  ADD CONSTRAINT file_objects_mime_type_check
    CHECK (mime_type ~ '^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$'),
  ADD CONSTRAINT file_objects_original_name_check
    CHECK (char_length(original_name) >= 1 AND original_name !~ '[[:cntrl:]]'),
  ADD CONSTRAINT file_objects_retention_class_check
    CHECK (retention_class ~ '^[A-Z][A-Z0-9_]*$'),
  ADD CONSTRAINT file_objects_pinned_check
    CHECK (status NOT IN ('UPLOADED', 'SCANNING', 'PROCESSING', 'READY')
       OR quarantine_version_id IS NOT NULL),
  ADD CONSTRAINT file_objects_promoted_check
    CHECK (object_key IS NULL OR (scan_verdict = 'CLEAN' AND sha256 IS NOT NULL)),
  ADD CONSTRAINT file_objects_ready_check
    CHECK ((status = 'READY') = (finalized_at IS NOT NULL)
       AND (status <> 'READY' OR (scan_verdict = 'CLEAN' AND object_key IS NOT NULL))),
  ADD CONSTRAINT file_objects_infected_check
    CHECK (scan_verdict <> 'INFECTED' OR status = 'REJECTED');

-- What an upload may hold. A positive size; a type, as a file's; an owner's
-- kind, lower-case words joined by hyphens; closed once, finalized or
-- aborted; an expiry after its making; a revision from 1.
ALTER TABLE upload_sessions
  ADD CONSTRAINT upload_sessions_declared_size_check
    CHECK (declared_size > 0),
  ADD CONSTRAINT upload_sessions_declared_type_check
    CHECK (declared_type ~ '^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$'),
  ADD CONSTRAINT upload_sessions_owner_kind_check
    CHECK (owner_kind ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'),
  ADD CONSTRAINT upload_sessions_closed_once_check
    CHECK (finalized_at IS NULL OR aborted_at IS NULL),
  ADD CONSTRAINT upload_sessions_expiry_check
    CHECK (expires_at > created_at),
  ADD CONSTRAINT upload_sessions_revision_check
    CHECK (revision >= 1);

-- A file's identity, once pinned, never changes: its quarantine key; its
-- quarantined version once pinned; its object, version and hash once
-- promoted; its size and creator. A replayed upload makes a new version in
-- the store, never a new truth here.
CREATE FUNCTION refuse_file_identity_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.quarantine_key IS DISTINCT FROM OLD.quarantine_key
     OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
     OR NEW.created_by_id IS DISTINCT FROM OLD.created_by_id
     OR (OLD.quarantine_version_id IS NOT NULL
         AND NEW.quarantine_version_id IS DISTINCT FROM OLD.quarantine_version_id)
     OR (OLD.object_version_id IS NOT NULL
         AND (NEW.object_key IS DISTINCT FROM OLD.object_key
              OR NEW.object_version_id IS DISTINCT FROM OLD.object_version_id
              OR NEW.sha256 IS DISTINCT FROM OLD.sha256)) THEN
    RAISE EXCEPTION '%: a file''s identity cannot change once pinned', TG_TABLE_NAME
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION refuse_file_identity_change() FROM PUBLIC;
CREATE TRIGGER file_objects_identity_immutable BEFORE UPDATE ON file_objects
  FOR EACH ROW EXECUTE FUNCTION refuse_file_identity_change();

-- As scripts/generate-rls.ts prints it for FileObject and UploadSession.
-- file_objects: one tenant's rows, by tenant_id.
ALTER TABLE file_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_objects FORCE ROW LEVEL SECURITY;
CREATE POLICY file_objects_tenant ON file_objects FOR ALL TO sadara_app
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY file_objects_owner_reads ON file_objects FOR SELECT TO sadara_owner USING (true);
CREATE TRIGGER file_objects_tenant_immutable BEFORE UPDATE ON file_objects
  FOR EACH ROW WHEN (OLD.tenant_id IS DISTINCT FROM NEW.tenant_id)
  EXECUTE FUNCTION refuse_tenant_change('tenant_id');
-- Closed by a state of its own, never removed.
REVOKE DELETE ON file_objects FROM sadara_app;

-- upload_sessions: one tenant's rows, by tenant_id.
ALTER TABLE upload_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE upload_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY upload_sessions_tenant ON upload_sessions FOR ALL TO sadara_app
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY upload_sessions_owner_reads ON upload_sessions FOR SELECT TO sadara_owner USING (true);
CREATE TRIGGER upload_sessions_tenant_immutable BEFORE UPDATE ON upload_sessions
  FOR EACH ROW WHEN (OLD.tenant_id IS DISTINCT FROM NEW.tenant_id)
  EXECUTE FUNCTION refuse_tenant_change('tenant_id');
-- Closed by a state of its own, never removed.
REVOKE DELETE ON upload_sessions FROM sadara_app;
