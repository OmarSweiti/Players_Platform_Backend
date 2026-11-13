import type { PrismaClient, Tenant } from '@prisma/client';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { permissionSyncSql } from '../../scripts/generate-permission-sync';
import {
  PermissionCatalogCheck,
  PermissionCatalogMismatch,
} from '../../src/common/authz/permission-catalog-check';
import { TenantTransactions } from '../../src/common/tenancy/tenant-transaction';
import { databaseConnectionOf } from '../../src/infrastructure/prisma/database-url';
import { PermissionService } from '../../src/modules/users/application/services/permission.service';
import { catalogDifferences } from '../../src/modules/users/domain/catalog-differences';
import {
  DEFAULT_ROLE_MATRIX,
  defaultGrants,
  type RoleName,
} from '../../src/modules/users/domain/default-role-matrix';
import {
  PERMISSION_CATALOG,
  PERMISSION_KEYS,
} from '../../src/modules/users/domain/permission-catalog';
import { PermissionRepository } from '../../src/modules/users/infrastructure/repositories/permission.repository';
import {
  createIsolatedSchema,
  type IsolatedSchema,
  prismaFor,
} from '../harness/db';
import { createTenant, runPrisma, testContext } from '../harness/fixtures';

// The permission catalog and the default role matrix (0.6.1): code, written
// by the migrations as scripts/generate-permission-sync.ts prints them, read
// by the runtime role, and checked by the API at boot. The run's schema is
// what the migrations made; a schema of this file's own takes what changes
// reference data, which only the migrator may write.

interface Snapshot {
  permissions: unknown[];
  grants: unknown[];
}

async function stored(
  prisma: Pick<PrismaClient, 'permission' | 'rolePermission'>,
) {
  const [permissions, grants] = await Promise.all([
    prisma.permission.findMany({
      select: { name: true, category: true, action: true, description: true },
    }),
    prisma.rolePermission.findMany({
      select: { roleId: true, permission: { select: { name: true } } },
    }),
  ]);
  return {
    permissions,
    grants: grants.map(({ roleId, permission }) => ({
      role: roleId,
      permission: permission.name,
    })),
  };
}

/** Runs SQL as the migrator in the private schema, in one transaction. */
async function asMigrator(url: string, sql: string): Promise<void> {
  const { connectionString, options } = databaseConnectionOf(url);
  const client = new Client({ connectionString, options });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

/** Every row and column, ids and times included, in a stable order. */
async function snapshot(prisma: PrismaClient): Promise<Snapshot> {
  return {
    permissions: await prisma.permission.findMany({ orderBy: { name: 'asc' } }),
    grants: await prisma.rolePermission.findMany({ orderBy: { id: 'asc' } }),
  };
}

const sync = permissionSyncSql();

describe('the permission catalog', () => {
  let own: IsolatedSchema;
  let runtime: ReturnType<typeof prismaFor>;
  let migrator: ReturnType<typeof prismaFor>;

  beforeAll(async () => {
    own = await createIsolatedSchema();
    runtime = prismaFor(own.url);
    migrator = prismaFor(own.migrationUrl);
  });

  afterAll(async () => {
    await Promise.all([runtime?.close(), migrator?.close()]);
    await own?.drop();
  });

  it('every_catalog_entry_can_be_stored', async () => {
    // As the migrations stored it, read as the runtime role.
    const inRun = new Map(
      (await stored(runPrisma())).permissions.map((row) => [row.name, row]),
    );
    for (const key of PERMISSION_KEYS) {
      const { category, action, description } = PERMISSION_CATALOG[key];
      expect(inRun.get(key)).toEqual({
        name: key,
        category,
        action,
        description,
      });
    }
    expect(inRun.size).toBe(PERMISSION_KEYS.length);

    // And from nothing: an empty catalog takes every entry, in one transaction.
    await asMigrator(
      own.migrationUrl,
      'DELETE FROM role_permissions; DELETE FROM permissions;',
    );
    expect(await runtime.prisma.permission.count()).toBe(0);
    await asMigrator(own.migrationUrl, sync);
    const fresh = await stored(runtime.prisma);
    expect(fresh.permissions.length).toBe(65);
    expect(catalogDifferences(fresh.permissions, fresh.grants)).toEqual([]);
  });

  it('the_database_matrix_equals_the_code_matrix', async () => {
    const { permissions, grants } = await stored(runPrisma());
    expect(catalogDifferences(permissions, grants)).toEqual([]);
    const key = ({ role, permission }: { role: string; permission: string }) =>
      `${role} ${permission}`;
    expect(grants.map(key).sort()).toEqual(defaultGrants().map(key).sort());
    expect(grants.filter(({ role }) => role === 'SUPER_ADMIN')).toEqual([]);

    // What a permission check answers, in each of two tenants' transactions:
    // the matrix belongs to no tenant, so both read the same one.
    const permissionService = new PermissionService(
      new TenantTransactions(runPrisma()),
      new PermissionRepository(),
    );
    const tenants: Tenant[] = [await createTenant(), await createTenant()];
    for (const tenant of tenants) {
      const ctx = testContext(tenant.id);
      for (const [role, held] of Object.entries(DEFAULT_ROLE_MATRIX) as [
        RoleName,
        readonly string[],
      ][]) {
        const answers = await Promise.all(
          PERMISSION_KEYS.map((permission) =>
            permissionService.hasPermission(ctx, role, permission),
          ),
        );
        expect([
          tenant.slug,
          role,
          PERMISSION_KEYS.filter((_, i) => answers[i]),
        ]).toEqual([
          tenant.slug,
          role,
          PERMISSION_KEYS.filter((permission) => held.includes(permission)),
        ]);
      }
    }
  });

  it('the_permission_sync_is_idempotent', async () => {
    // Run again on a database that is the code's: nothing is written, not
    // even an updated_at.
    const before = await snapshot(migrator.prisma);
    await asMigrator(own.migrationUrl, sync);
    expect(await snapshot(migrator.prisma)).toEqual(before);

    // A database that drifted is brought back, and only what drifted.
    await asMigrator(
      own.migrationUrl,
      `
      UPDATE permissions SET category = 'MATCH', description = 'drifted' WHERE name = 'player.read';
      DELETE FROM role_permissions
       WHERE role_id = 'ADMIN' AND permission_id = (SELECT id FROM permissions WHERE name = 'user.invite');
      INSERT INTO role_permissions (id, role_id, permission_id)
      SELECT gen_random_uuid(), 'SUPER_ADMIN', id FROM permissions WHERE name = 'medical.read';
      INSERT INTO permissions (id, name, category, action, description, updated_at)
      VALUES (gen_random_uuid(), 'everything.all', 'TENANT', 'MANAGE', 'stray', CURRENT_TIMESTAMP);
      INSERT INTO role_permissions (id, role_id, permission_id)
      SELECT gen_random_uuid(), 'OWNER', id FROM permissions WHERE name = 'everything.all';
      `,
    );
    const drifted = await stored(runtime.prisma);
    expect(catalogDifferences(drifted.permissions, drifted.grants)).toEqual([
      'ADMIN lacks user.invite',
      'OWNER holds everything.all, which the matrix does not grant',
      'SUPER_ADMIN holds medical.read, which the matrix does not grant',
      'everything.all is not in the catalog',
      "player.read's category is MATCH, not PLAYER",
      "player.read's description is not the catalog's",
    ]);

    await asMigrator(own.migrationUrl, sync);
    const restored = await stored(runtime.prisma);
    expect(catalogDifferences(restored.permissions, restored.grants)).toEqual(
      [],
    );
    const after = await snapshot(migrator.prisma);
    type Row = { id: string; name?: string; updatedAt?: Date };
    const byId = (rows: unknown[]) =>
      new Map((rows as Row[]).map((row) => [row.id, row]));
    const was = byId(before.permissions);
    const now = byId(after.permissions);
    // Every permission keeps its id; only the drifted one has a new updated_at.
    expect([...now.keys()].sort()).toEqual([...was.keys()].sort());
    const touched = [...now.values()]
      .filter(
        (row) =>
          row.updatedAt?.getTime() !== was.get(row.id)?.updatedAt?.getTime(),
      )
      .map((row) => row.name);
    expect(touched).toEqual(['player.read']);
    // Every grant the drift left alone is the same row; one was made again.
    const grantsWere = byId(before.grants);
    const grantsNow = byId(after.grants);
    expect(grantsNow.size).toBe(grantsWere.size);
    expect(
      [...grantsNow.keys()].filter((id) => !grantsWere.has(id)).length,
    ).toBe(1);

    // And once more: nothing.
    await asMigrator(own.migrationUrl, sync);
    expect(await snapshot(migrator.prisma)).toEqual(after);
  });

  it('the_api_refuses_to_boot_when_the_database_is_not_the_code', async () => {
    // The run's schema, as the migrations made it: the check passes.
    await expect(
      new PermissionCatalogCheck(runPrisma()).onApplicationBootstrap(),
    ).resolves.toBeUndefined();

    // A grant the matrix does not make, read as the runtime role: refused,
    // naming it.
    await asMigrator(
      own.migrationUrl,
      `INSERT INTO role_permissions (id, role_id, permission_id)
       SELECT gen_random_uuid(), 'SUPER_ADMIN', id FROM permissions WHERE name = 'tenant.manage';`,
    );
    const refusal = new PermissionCatalogCheck(
      runtime.prisma,
    ).onApplicationBootstrap();
    await expect(refusal).rejects.toBeInstanceOf(PermissionCatalogMismatch);
    await expect(refusal).rejects.toThrow(
      'SUPER_ADMIN holds tenant.manage, which the matrix does not grant',
    );
    await asMigrator(own.migrationUrl, sync);
    await expect(
      new PermissionCatalogCheck(runtime.prisma).onApplicationBootstrap(),
    ).resolves.toBeUndefined();
  });

  it('the_runtime_role_cannot_change_the_catalog', async () => {
    // Reference data: the migrations write it; the runtime role only reads.
    await expect(
      runtime.prisma.$executeRawUnsafe(
        `UPDATE permissions SET description = 'x' WHERE name = 'player.read'`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      runtime.prisma.$executeRawUnsafe(`DELETE FROM role_permissions`),
    ).rejects.toThrow(/permission denied/);
  });

  it('a_permission_never_takes_its_grants_with_it', async () => {
    // RESTRICT (DB-53): deleting a held permission fails, even for the migrator.
    await expect(
      asMigrator(
        own.migrationUrl,
        `DELETE FROM permissions WHERE name = 'player.read'`,
      ),
    ).rejects.toThrow(/violates RESTRICT setting of foreign key constraint/);
    const { permissions, grants } = await stored(runtime.prisma);
    expect(catalogDifferences(permissions, grants)).toEqual([]);
  });
});
