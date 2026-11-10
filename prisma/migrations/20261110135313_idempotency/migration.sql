-- Idempotency keys for retried commands (0.7.7; I-10, SR-CORE-010). A command
-- a client may retry takes an `Idempotency-Key`; its first execution claims
-- the key here, under a bounded lease, and commits its outcome with its
-- effect: a retry of the same key and request is answered from the record,
-- without a second effect, and the same key with another request is refused.
--
-- A key belongs to one member of one tenant, for one method and canonical
-- path: the namespace leads with the tenant, as every tenant index does, so a
-- key tells no one about another tenant's or another member's. Neither the key
-- nor the request is kept, only their SHA-256 hashes; an outcome is the id of
-- what a success made or changed, or a refusal's error code, never a body. A
-- claim whose lease ran out may be taken over: its fencing generation is
-- incremented, and an execution holding the old one cannot commit.
--
-- Tenant-owned, under forced row-level security like every tenant table. An
-- expired record answers nothing: the runtime role removes it when its key
-- is claimed again.
--
-- A new, empty table: nothing to preflight.

-- CreateEnum
CREATE TYPE "idempotency_state" AS ENUM ('IN_PROGRESS', 'SUCCEEDED', 'REJECTED');

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "method" VARCHAR(7) NOT NULL,
    "canonical_path" VARCHAR(512) NOT NULL,
    "key_hash" BYTEA NOT NULL,
    "request_hash" BYTEA NOT NULL,
    "state" "idempotency_state" NOT NULL DEFAULT 'IN_PROGRESS',
    "fencing_generation" INTEGER NOT NULL DEFAULT 1,
    "lease_until" TIMESTAMPTZ(3),
    "result_ref" UUID,
    "outcome_code" VARCHAR(40),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_id_tenant_id_key" ON "idempotency_records"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_namespace_key" ON "idempotency_records"("tenant_id", "actor_user_id", "method", "canonical_path", "key_hash");

-- AddForeignKey
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_actor_user_id_tenant_id_fkey" FOREIGN KEY ("actor_user_id", "tenant_id") REFERENCES "users"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- What a row may hold (hand-written; test/db/idempotency.integration-spec.ts).
-- A command's method; a path from the root, in printable ASCII; hashes of
-- SHA-256's length; a generation from 1. A lease exactly while the claim is
-- IN_PROGRESS, a completion time exactly once it is not; a refusal names its
-- error code, and only a success names what it made or changed. A record
-- expires after it was made.
ALTER TABLE idempotency_records
  ADD CONSTRAINT idempotency_records_method_check
    CHECK (method IN ('POST', 'PUT', 'PATCH', 'DELETE')),
  ADD CONSTRAINT idempotency_records_canonical_path_check
    CHECK (canonical_path ~ '^/[!-~]*$'),
  ADD CONSTRAINT idempotency_records_key_hash_check
    CHECK (octet_length(key_hash) = 32),
  ADD CONSTRAINT idempotency_records_request_hash_check
    CHECK (octet_length(request_hash) = 32),
  ADD CONSTRAINT idempotency_records_fencing_generation_check
    CHECK (fencing_generation >= 1),
  ADD CONSTRAINT idempotency_records_lease_check
    CHECK ((state = 'IN_PROGRESS') = (lease_until IS NOT NULL)),
  ADD CONSTRAINT idempotency_records_outcome_check
    CHECK ((state = 'IN_PROGRESS') = (completed_at IS NULL)
       AND (state = 'REJECTED') = (outcome_code IS NOT NULL)
       AND (state = 'SUCCEEDED' OR result_ref IS NULL)),
  ADD CONSTRAINT idempotency_records_outcome_code_check
    CHECK (outcome_code ~ '^[A-Z][A-Z_]*$'),
  ADD CONSTRAINT idempotency_records_expiry_check
    CHECK (expires_at > created_at);

-- As scripts/generate-rls.ts prints it for IdempotencyRecord.
-- idempotency_records: one tenant's rows, by tenant_id.
ALTER TABLE idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_records FORCE ROW LEVEL SECURITY;
CREATE POLICY idempotency_records_tenant ON idempotency_records FOR ALL TO sadara_app
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY idempotency_records_owner_reads ON idempotency_records FOR SELECT TO sadara_owner USING (true);
CREATE TRIGGER idempotency_records_tenant_immutable BEFORE UPDATE ON idempotency_records
  FOR EACH ROW WHEN (OLD.tenant_id IS DISTINCT FROM NEW.tenant_id)
  EXECUTE FUNCTION refuse_tenant_change('tenant_id');
