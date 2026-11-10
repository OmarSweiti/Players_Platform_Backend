-- The transactional outbox and the consumer inbox (0.7.5; I-10, SYS-ASY-002,
-- SYS-ASY-005, BR-RULE-10). A change that must have an effect after it — an
-- email, a notification, a projection elsewhere — writes the intent in its own
-- transaction (outbox_events), so the intent commits with the change or not at
-- all, and survives the broker's loss; it is delivered at least once from
-- there (the relay and the worker are 0.7.6's). A consumer records its receipt
-- (consumer_inbox) in the same transaction as its effect, so the effect
-- commits once however often the event is delivered.
--
-- Both are tenant-owned, under forced row-level security like every tenant
-- table, and kept: the runtime role never removes an event still needed for
-- replay, nor the receipt that stops a second effect. An event's payload holds
-- identifiers only. A dedup key is unique in its tenant, not across tenants:
-- a key shared across tenants would let one tenant learn another's by a
-- conflict. A receipt's key to its event carries the tenant, so a receipt
-- can name only an event of its own tenant.
--
-- New, empty tables: nothing to preflight.

-- CreateEnum
CREATE TYPE "outbox_status" AS ENUM ('CREATED', 'LEASED', 'PUBLISHED', 'DEAD');

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "type" VARCHAR(100) NOT NULL,
    "aggregate_type" VARCHAR(100) NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "payload_version" SMALLINT NOT NULL,
    "payload_refs" JSONB NOT NULL,
    "dedup_key" VARCHAR(200) NOT NULL,
    "status" "outbox_status" NOT NULL DEFAULT 'CREATED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_owner" VARCHAR(100),
    "lease_until" TIMESTAMPTZ(3),
    "dispatched_at" TIMESTAMPTZ(3),
    "last_error_code" VARCHAR(100),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consumer_inbox" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "consumer" VARCHAR(100) NOT NULL,
    "event_id" UUID NOT NULL,
    "completed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "result_ref" VARCHAR(200),

    CONSTRAINT "consumer_inbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "outbox_events_tenant_id_status_available_at_idx" ON "outbox_events"("tenant_id", "status", "available_at");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_id_tenant_id_key" ON "outbox_events"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_tenant_id_dedup_key_key" ON "outbox_events"("tenant_id", "dedup_key");

-- CreateIndex
CREATE INDEX "consumer_inbox_tenant_id_event_id_idx" ON "consumer_inbox"("tenant_id", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "consumer_inbox_id_tenant_id_key" ON "consumer_inbox"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "consumer_inbox_tenant_id_consumer_event_id_key" ON "consumer_inbox"("tenant_id", "consumer", "event_id");

-- AddForeignKey
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "consumer_inbox" ADD CONSTRAINT "consumer_inbox_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "consumer_inbox" ADD CONSTRAINT "consumer_inbox_event_id_tenant_id_fkey" FOREIGN KEY ("event_id", "tenant_id") REFERENCES "outbox_events"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- What a row may hold (hand-written; test/db/outbox.integration-spec.ts).
-- A type is lower_snake words joined by dots, at least an entity and what
-- happened; the aggregate is an entity's name; counts are not negative; the
-- dedup key is not empty; a lease's owner and end come together, exactly
-- while the event is LEASED; a dispatch time exactly while it is PUBLISHED; a
-- DEAD event names its last error; the payload is a small object.
ALTER TABLE outbox_events
  ADD CONSTRAINT outbox_events_type_check
    CHECK (type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  ADD CONSTRAINT outbox_events_aggregate_type_check
    CHECK (aggregate_type ~ '^[A-Z][A-Za-z0-9]*$'),
  ADD CONSTRAINT outbox_events_payload_version_check
    CHECK (payload_version >= 1),
  ADD CONSTRAINT outbox_events_attempts_check
    CHECK (attempts >= 0),
  ADD CONSTRAINT outbox_events_dedup_key_check
    CHECK (dedup_key <> ''),
  ADD CONSTRAINT outbox_events_lease_check
    CHECK ((lease_owner IS NULL) = (lease_until IS NULL)
       AND (status = 'LEASED') = (lease_until IS NOT NULL)),
  ADD CONSTRAINT outbox_events_dispatch_check
    CHECK ((status = 'PUBLISHED') = (dispatched_at IS NOT NULL)),
  ADD CONSTRAINT outbox_events_dead_check
    CHECK (status <> 'DEAD' OR last_error_code IS NOT NULL),
  ADD CONSTRAINT outbox_events_payload_refs_check
    CHECK (jsonb_typeof(payload_refs) = 'object' AND octet_length(payload_refs::text) <= 4096);

-- A consumer is named by lower-case words joined by dots.
ALTER TABLE consumer_inbox
  ADD CONSTRAINT consumer_inbox_consumer_check
    CHECK (consumer ~ '^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$');

-- As scripts/generate-rls.ts prints it for OutboxEvent and ConsumerInbox.
-- outbox_events: one tenant's rows, by tenant_id.
ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;
CREATE POLICY outbox_events_tenant ON outbox_events FOR ALL TO sadara_app
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY outbox_events_owner_reads ON outbox_events FOR SELECT TO sadara_owner USING (true);
CREATE TRIGGER outbox_events_tenant_immutable BEFORE UPDATE ON outbox_events
  FOR EACH ROW WHEN (OLD.tenant_id IS DISTINCT FROM NEW.tenant_id)
  EXECUTE FUNCTION refuse_tenant_change('tenant_id');
-- Closed by a state of its own, never removed.
REVOKE DELETE ON outbox_events FROM sadara_app;

-- consumer_inbox: one tenant's rows, by tenant_id.
ALTER TABLE consumer_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE consumer_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY consumer_inbox_tenant ON consumer_inbox FOR ALL TO sadara_app
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY consumer_inbox_owner_reads ON consumer_inbox FOR SELECT TO sadara_owner USING (true);
CREATE TRIGGER consumer_inbox_tenant_immutable BEFORE UPDATE ON consumer_inbox
  FOR EACH ROW WHEN (OLD.tenant_id IS DISTINCT FROM NEW.tenant_id)
  EXECUTE FUNCTION refuse_tenant_change('tenant_id');
-- Closed by a state of its own, never removed.
REVOKE DELETE ON consumer_inbox FROM sadara_app;
