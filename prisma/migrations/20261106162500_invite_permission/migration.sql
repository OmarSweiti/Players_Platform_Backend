-- The permission to invite (0.5.10), and the roles that hold it by default:
-- reference data, which the migrations write and the runtime role only reads
-- (model-classification.ts). Only an owner or an administrator invites, and
-- what each may grant is the invitation's own rule
-- (src/modules/users/domain/role-grants.ts). The catalog becomes code, and
-- the whole matrix is synchronised from it, in 0.6.1.
INSERT INTO permissions (id, name, category, action, description, updated_at)
VALUES (gen_random_uuid(), 'user.invite', 'USER', 'INVITE', 'invite user', CURRENT_TIMESTAMP)
ON CONFLICT (name) DO NOTHING;

INSERT INTO role_permissions (id, role_id, permission_id)
SELECT gen_random_uuid(), holder.role, permissions.id
  FROM permissions
 CROSS JOIN (VALUES ('OWNER'::user_role), ('ADMIN'::user_role)) AS holder (role)
 WHERE permissions.name = 'user.invite'
ON CONFLICT (role_id, permission_id) DO NOTHING;
