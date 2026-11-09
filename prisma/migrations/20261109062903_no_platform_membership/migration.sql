-- No implicit platform access (0.6.7; SR-ACL-003, BR-RULE-12, DB-45).
-- SUPER_ADMIN is a platform role: it holds no tenant-data permission (the
-- stored matrix grants it none, 0.6.1), and no tenant membership holds it. A
-- users row is a membership of one tenant, so a SUPER_ADMIN there would be
-- the platform inside a tenant, by role alone. Nothing a tenant does grants
-- it: an invitation cannot name it (invitations_role_check, 0.5.10), and with
-- this CHECK no member is made one or changed into one, archived members
-- included, since reactivation brings back the role a membership had.
-- Platform operators stay apart from tenant membership, and reach a tenant
-- only through an audited, time-boxed support grant (4.1.1, 4.1.2).
--
-- A membership that holds SUPER_ADMIN stops the migration: the seed of before
-- 0.5.11 made one. It is never deleted or changed here (just preflight lists
-- it as platform_membership); the owner decides what becomes of it.
--
-- Prisma runs this file as one transaction. The tables hold only synthetic data
-- (ADR-0021); a lock not granted within 5 s fails the migration rather than
-- queueing every request behind it.
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF EXISTS (SELECT FROM users WHERE role = 'SUPER_ADMIN') THEN
    RAISE EXCEPTION 'a tenant membership holds SUPER_ADMIN, a platform role'
      USING HINT = 'just preflight lists it (platform_membership); the owner decides what becomes of the membership, which is corrected, never deleted, before this migrates';
  END IF;
END
$$;

ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role <> 'SUPER_ADMIN');
