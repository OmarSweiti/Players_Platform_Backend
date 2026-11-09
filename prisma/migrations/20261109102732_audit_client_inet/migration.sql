-- The client's address in audit is inet (0.7.2; DB-56). The audit service
-- records the request's client with each entry, inside the business
-- transaction, and keeps only an address inet takes and a user agent cut to
-- its 500 characters: request metadata can never fail the insert, and so
-- never abort the change.
--
-- The column is converted in place, never dropped and added again: an address
-- already recorded is evidence, and keeps its value. An address inet would not
-- take stops the migration instead; it is never changed or erased here (just
-- preflight lists it as audit_address_not_inet), and the owner decides.
--
-- Prisma runs this file as one transaction. A conversion fires no row trigger,
-- so append-only audit (0.7.1) stands throughout. The tables hold only
-- synthetic data (ADR-0021); a lock not granted within 5 s fails the migration
-- rather than queueing every request behind it.
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF EXISTS (SELECT FROM audit_logs
              WHERE ip_address IS NOT NULL AND NOT pg_input_is_valid(ip_address, 'inet')) THEN
    RAISE EXCEPTION 'an audit row holds a client address that is not an inet value'
      USING HINT = 'just preflight lists it (audit_address_not_inet); the owner decides, and the row is evidence, never changed or erased here';
  END IF;
END
$$;

-- AlterTable
ALTER TABLE "audit_logs" ALTER COLUMN "ip_address" TYPE INET USING "ip_address"::inet;
