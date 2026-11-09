-- Security events that have no tenant (0.7.3; SR-AUD-001, DB-33, DB-61).
-- A refused sign-in on an unknown host belongs to no tenant, and audit_logs
-- needs one: inventing it would falsify the record. security_events is
-- global, and holds what Sadara sees of authentication (sign-ins and their
-- refusals, step-ups, sign-outs, session revocations, back-channel logouts)
-- and the identity provider's own login and admin events, imported and kept
-- once each by the provider's event id.
--
-- Evidence, as audit is (0.7.1): the runtime role inserts rows and reads
-- none, since reading is a security operator's; triggers refuse UPDATE,
-- DELETE and TRUNCATE for every role, the owner included, on 0.7.1's
-- reject_evidence_mutation(). A tenant is only ever a hint (the tenant the
-- request's host named), never a foreign key. Who is the provider's issuer
-- and subject; the client's address is an HMAC under a key of its own, never
-- the address.
--
-- A new, empty table: nothing to preflight.

-- CreateEnum
CREATE TYPE "security_event_source" AS ENUM ('SADARA', 'PROVIDER');

-- CreateEnum
CREATE TYPE "security_event_outcome" AS ENUM ('SUCCEEDED', 'REFUSED');

-- CreateTable
CREATE TABLE "security_events" (
    "id" UUID NOT NULL,
    "source" "security_event_source" NOT NULL,
    "event_type" VARCHAR(100) NOT NULL,
    "outcome" "security_event_outcome" NOT NULL,
    "reason_code" VARCHAR(100),
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenant_hint" UUID,
    "issuer" VARCHAR(500),
    "subject" VARCHAR(255),
    "session_id" UUID,
    "request_id" VARCHAR(128),
    "network_hash" BYTEA,
    "provider_event_id" VARCHAR(200),
    "metadata" JSONB,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "security_events_provider_event_id_key" ON "security_events"("provider_event_id");

-- CreateIndex
CREATE INDEX "security_events_occurred_at_idx" ON "security_events"("occurred_at");

-- CreateIndex
CREATE INDEX "security_events_tenant_hint_occurred_at_idx" ON "security_events"("tenant_hint", "occurred_at");


-- What a row may hold (hand-written; test/db/security-events.integration-spec.ts).
-- A type is lower_snake words joined by dots; a reason is a code, never a
-- value, and a refusal always has one; an imported event has the provider's
-- id and no other does; a subject comes with its issuer; the hash is
-- SHA-256's 32 bytes; metadata is a small object.
ALTER TABLE security_events
  ADD CONSTRAINT security_events_event_type_check
    CHECK (event_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  ADD CONSTRAINT security_events_reason_code_check
    CHECK (reason_code ~ '^[a-z0-9][a-z0-9_.:-]*$'),
  ADD CONSTRAINT security_events_refusal_check
    CHECK (outcome = 'SUCCEEDED' OR reason_code IS NOT NULL),
  ADD CONSTRAINT security_events_source_check
    CHECK ((source = 'PROVIDER') = (provider_event_id IS NOT NULL)),
  ADD CONSTRAINT security_events_provider_event_id_check
    CHECK (provider_event_id ~ '^(login|admin):[A-Za-z0-9-]+$'),
  ADD CONSTRAINT security_events_identity_check
    CHECK (subject IS NULL OR issuer IS NOT NULL),
  ADD CONSTRAINT security_events_network_hash_check
    CHECK (octet_length(network_hash) = 32),
  ADD CONSTRAINT security_events_metadata_check
    CHECK (jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 4096);

-- As scripts/generate-rls.ts prints it for SecurityEvent.
-- security_events: global evidence; the runtime role adds rows and reads none, and no role changes or removes one.
REVOKE SELECT, UPDATE, DELETE, TRUNCATE ON security_events FROM sadara_app;
CREATE TRIGGER security_events_no_update_delete BEFORE UPDATE OR DELETE ON security_events
  FOR EACH ROW EXECUTE FUNCTION reject_evidence_mutation();
CREATE TRIGGER security_events_no_truncate BEFORE TRUNCATE ON security_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_evidence_mutation();
