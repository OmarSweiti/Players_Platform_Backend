-- The outbox's delivery (0.7.6). The relay claims an event, hands it to the
-- queue (PUBLISHED), and the worker runs its consumers; retries back off to a
-- bound, and an event whose last attempt fails is DEAD, with its last error.
-- An event may therefore be DEAD after it was dispatched, or before, when it
-- could not be: the dispatch CHECK says only that a PUBLISHED event was
-- dispatched and that one still CREATED or LEASED was not.
--
-- An event also keeps the request it was enqueued in, so that its job runs in
-- that correlation (runCorrelatedJob, 0.10.1). Rows from before carry none.
-- AlterTable
ALTER TABLE "outbox_events" ADD COLUMN     "request_id" VARCHAR(128);


ALTER TABLE outbox_events
  DROP CONSTRAINT outbox_events_dispatch_check,
  ADD CONSTRAINT outbox_events_dispatch_check
    CHECK ((status <> 'PUBLISHED' OR dispatched_at IS NOT NULL)
       AND (status NOT IN ('CREATED', 'LEASED') OR dispatched_at IS NULL));
