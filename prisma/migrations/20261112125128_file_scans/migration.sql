-- The scan's record on a file (0.8.4; SR-DOC-004, ADR-0009): how many times
-- it has been tried, when its verdict was reached, and what the scanner
-- found. One transaction (ADR-0021: a migration lands whole or not at all).
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "file_objects" ADD COLUMN     "scan_attempts" SMALLINT NOT NULL DEFAULT 0,
ADD COLUMN     "scan_finding" VARCHAR(200),
ADD COLUMN     "scanned_at" TIMESTAMPTZ(3);

-- Every file so far is PENDING, untried and unscanned: the checks hold of
-- every row as it stands (just preflight before migrating).
ALTER TABLE file_objects
  -- Tried a bounded number of times: the outbox delivers an event 8 times
  -- (src/infrastructure/queue/outbox-queue.ts), a manual retry a few more.
  ADD CONSTRAINT file_objects_scan_attempts_check
    CHECK (scan_attempts BETWEEN 0 AND 32),
  -- A verdict has its time, and PENDING has none.
  ADD CONSTRAINT file_objects_scanned_check
    CHECK ((scan_verdict = 'PENDING') = (scanned_at IS NULL)),
  -- A finding is an INFECTED file's, named in printable characters.
  ADD CONSTRAINT file_objects_scan_finding_check
    CHECK ((scan_verdict = 'INFECTED') = (scan_finding IS NOT NULL)
       AND scan_finding ~ '^[!-~][ -~]*$');
