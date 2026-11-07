-- The types the permission catalog needs (0.6.1). Each catalog entry declares
-- its category and action (src/modules/users/domain/permission-catalog.ts);
-- nothing is parsed from its name. These are the three no existing value
-- names: a rejection and a submission are decisions of their own, and
-- performance data is its own area. The catalog itself is written by the next
-- migration, since PostgreSQL cannot use an enum value in the transaction
-- that adds it.
ALTER TYPE "permission_action" ADD VALUE 'REJECT';
ALTER TYPE "permission_action" ADD VALUE 'SUBMIT';

ALTER TYPE "permission_category" ADD VALUE 'PERFORMANCE';

-- A permission goes only once no role holds it: deleting one never takes its
-- grants with it (DB-53).
ALTER TABLE "role_permissions" DROP CONSTRAINT "role_permissions_permission_id_fkey";

ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
