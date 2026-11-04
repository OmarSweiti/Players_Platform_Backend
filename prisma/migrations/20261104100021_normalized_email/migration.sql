-- Normalised emails; lifetime uniqueness (0.4.9; SR-ACL-002, DB-10). A member's
-- address is unique within the tenant in its normal form — NFKC, without the
-- spaces around it, in lower case — for the life of the membership: an archived
-- member (deleted_at set) keeps theirs, so bringing them back reactivates the
-- same membership rather than creating a second account. The raw address stays
-- as the member gave it; the unique key moves to the normal form.
--
-- Two members of one tenant whose addresses collide once normalised stop the
-- migration: they are never merged, and neither is changed here (just preflight
-- lists them as duplicate_email). The backfill writes users, which the owner
-- may only read under forced row-level security (0.4.5), so FORCE is lifted for
-- the update and restored at once, inside this transaction.
--
-- Prisma runs this file as one transaction. The tables hold only synthetic data
-- (ADR-0021); a lock not granted within 5 s fails the migration rather than
-- queueing every request behind it.
SET LOCAL lock_timeout = '5s';

ALTER TABLE users ADD COLUMN normalized_email VARCHAR(255);

ALTER TABLE users NO FORCE ROW LEVEL SECURITY;
UPDATE users SET normalized_email = lower(btrim(normalize(email, NFKC), E' \t\r\n'));
ALTER TABLE users FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT FROM users GROUP BY tenant_id, normalized_email HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'two members of one tenant share an address once it is normalised'
      USING HINT = 'just preflight lists them (duplicate_email); the owner decides which membership keeps the address, and the other is corrected, never merged, before this migrates';
  END IF;
END
$$;

-- The normal form is the address's, always: src/modules/users/domain/email.ts
-- computes it the same way.
ALTER TABLE users
  ALTER COLUMN normalized_email SET NOT NULL,
  ADD CONSTRAINT users_normalized_email_check
    CHECK (normalized_email = lower(btrim(normalize(email, NFKC), E' \t\r\n')));

-- Unique by the normal form, archived members included.
DROP INDEX users_tenant_id_email_key;
CREATE UNIQUE INDEX users_tenant_id_normalized_email_key ON users (tenant_id, normalized_email);
