-- Transactional email with honest delivery semantics (0.7.8). An outbox
-- event's consumer records each email it is to send here, in its own
-- transaction, once per event and recipient; the worker then sends it,
-- outside any transaction, and records what the mail server answered. What is
-- promised: the intent is durable (the outbox) and local processing happens
-- once — a redelivered event sends nothing more once its email is recorded as
-- sent. What is not: delivery exactly once. A worker that stops after the
-- server accepted a message, before recording it, sends it again; attempts are
-- bounded, and an email that keeps failing ends FAILED, never silently.
--
-- Tenant-owned, under forced row-level security like every tenant table, and
-- kept: the runtime role never removes the record that an email was sent. The
-- recipient is a hash of the address, and no body is kept: a message is built
-- again at each attempt. A delivery's key to its event carries the tenant, so
-- it can name only an event of its own tenant.
--
-- A new, empty table: nothing to preflight.

-- CreateEnum
CREATE TYPE "email_delivery_status" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "email_deliveries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "template" VARCHAR(60) NOT NULL,
    "recipient_hash" BYTEA NOT NULL,
    "locale" VARCHAR(2) NOT NULL,
    "status" "email_delivery_status" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error_code" VARCHAR(100),
    "message_id" VARCHAR(255),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_attempt_at" TIMESTAMPTZ(3),
    "sent_at" TIMESTAMPTZ(3),

    CONSTRAINT "email_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_deliveries_id_tenant_id_key" ON "email_deliveries"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_deliveries_event_recipient_key" ON "email_deliveries"("tenant_id", "event_id", "recipient_hash");

-- AddForeignKey
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_event_id_tenant_id_fkey" FOREIGN KEY ("event_id", "tenant_id") REFERENCES "outbox_events"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- What a row may hold (hand-written; test/mail/email.integration-spec.ts). A
-- template is lower-case words joined by hyphens; the recipient's hash is
-- SHA-256's length; the locale is Arabic or English; counts are not negative,
-- and an attempt's time comes with the first attempt. An email sending, sent
-- or failed has been attempted; a time and a Message-ID exactly when sent; a
-- FAILED email names its last error.
ALTER TABLE email_deliveries
  ADD CONSTRAINT email_deliveries_template_check
    CHECK (template ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'),
  ADD CONSTRAINT email_deliveries_recipient_hash_check
    CHECK (octet_length(recipient_hash) = 32),
  ADD CONSTRAINT email_deliveries_locale_check
    CHECK (locale IN ('ar', 'en')),
  ADD CONSTRAINT email_deliveries_attempts_check
    CHECK (attempts >= 0 AND (attempts = 0) = (last_attempt_at IS NULL)
       AND (status NOT IN ('SENDING', 'SENT', 'FAILED') OR attempts >= 1)),
  ADD CONSTRAINT email_deliveries_sent_check
    CHECK ((status = 'SENT') = (sent_at IS NOT NULL)
       AND (status = 'SENT') = (message_id IS NOT NULL)),
  ADD CONSTRAINT email_deliveries_message_id_check
    CHECK (message_id ~ '^<[!-;=?-~]+@[!-;=?-~]+>$'),
  ADD CONSTRAINT email_deliveries_failed_check
    CHECK (status <> 'FAILED' OR last_error_code IS NOT NULL);

-- As scripts/generate-rls.ts prints it for EmailDelivery.
-- email_deliveries: one tenant's rows, by tenant_id.
ALTER TABLE email_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY email_deliveries_tenant ON email_deliveries FOR ALL TO sadara_app
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY email_deliveries_owner_reads ON email_deliveries FOR SELECT TO sadara_owner USING (true);
CREATE TRIGGER email_deliveries_tenant_immutable BEFORE UPDATE ON email_deliveries
  FOR EACH ROW WHEN (OLD.tenant_id IS DISTINCT FROM NEW.tenant_id)
  EXECUTE FUNCTION refuse_tenant_change('tenant_id');
-- Closed by a state of its own, never removed.
REVOKE DELETE ON email_deliveries FROM sadara_app;
