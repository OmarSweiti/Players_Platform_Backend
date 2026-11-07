// The permission catalog and the default role matrix as SQL (0.6.1;
// ADR-0005): prints the statements that make `permissions` and
// `role_permissions` exactly the code's, for a migration to carry as printed.
// The permission_catalog migration carries the first; a change to
// src/modules/users/domain/permission-catalog.ts or default-role-matrix.ts
// ships a new migration with this script's output (.claude/rules/migrations.md).
//   npx --no-install ts-node --transpile-only scripts/generate-permission-sync.ts
// Run again on a database that is already the code's, the SQL changes
// nothing, not even an updated_at; the migration's transaction makes it one
// change. The API refuses to boot until the database is the code's
// (src/common/authz/permission-catalog-check.ts).
import { defaultGrants } from '../src/modules/users/domain/default-role-matrix';
import {
  PERMISSION_CATALOG,
  PERMISSION_KEYS,
} from '../src/modules/users/domain/permission-catalog';

/** A SQL string literal. The catalog's text is the code's own, never input. */
function literal(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

function rows(lines: readonly string[], indent = '  '): string {
  return lines.map((line) => `${indent}${line}`).join(',\n');
}

export function permissionSyncSql(): string {
  const permissions = rows(
    PERMISSION_KEYS.map((key) => {
      const { category, action, description } = PERMISSION_CATALOG[key];
      return `(gen_random_uuid(), ${literal(key)}, ${literal(category)}, ${literal(action)}, ${literal(description)}, CURRENT_TIMESTAMP)`;
    }),
  );
  const grants = rows(
    defaultGrants().map(
      ({ role, permission }) =>
        `(${literal(role)}::user_role, ${literal(permission)})`,
    ),
    '    ',
  );
  const names = rows(PERMISSION_KEYS.map(literal));
  return [
    '-- The permission catalog and the default role matrix (0.6.1), as',
    '-- scripts/generate-permission-sync.ts prints them from',
    '-- src/modules/users/domain/{permission-catalog,default-role-matrix}.ts.',
    '-- Reference data: the migrations write it, the runtime role only reads it.',
    '',
    '-- Every permission, as the catalog declares it; a stored one that differs is',
    '-- brought back to it, and one that does not is left alone.',
    'INSERT INTO permissions (id, name, category, action, description, updated_at)',
    'VALUES',
    permissions,
    'ON CONFLICT (name) DO UPDATE',
    '   SET category = EXCLUDED.category,',
    '       action = EXCLUDED.action,',
    '       description = EXCLUDED.description,',
    '       updated_at = CURRENT_TIMESTAMP',
    ' WHERE (permissions.category, permissions.action, permissions.description)',
    '       IS DISTINCT FROM (EXCLUDED.category, EXCLUDED.action, EXCLUDED.description);',
    '',
    '-- Every grant the matrix makes, and no other.',
    'WITH matrix (role, name) AS (',
    '  VALUES',
    grants,
    '), wanted AS (',
    '  SELECT matrix.role, permissions.id AS permission_id',
    '    FROM matrix',
    '    JOIN permissions ON permissions.name = matrix.name',
    '), revoked AS (',
    '  DELETE FROM role_permissions',
    '   WHERE (role_id, permission_id) NOT IN (SELECT role, permission_id FROM wanted)',
    ')',
    'INSERT INTO role_permissions (id, role_id, permission_id)',
    'SELECT gen_random_uuid(), role, permission_id',
    '  FROM wanted',
    'ON CONFLICT (role_id, permission_id) DO NOTHING;',
    '',
    '-- No permission the catalog does not declare. None is held any more, which',
    '-- the foreign key requires: a permission never takes its grants with it.',
    'DELETE FROM permissions',
    ' WHERE name NOT IN (',
    names,
    ' );',
  ].join('\n');
}

function main(): void {
  process.stdout.write(`${permissionSyncSql()}\n`);
}

if (process.argv[1]?.endsWith('generate-permission-sync.ts')) main();
