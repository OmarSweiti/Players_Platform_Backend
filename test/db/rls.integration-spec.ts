import { randomUUID } from 'node:crypto';
import { Prisma, type Player, type Tenant, type User } from '@prisma/client';
import { Client, type DatabaseError } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { TenantTransactions } from '../../src/common/tenancy/tenant-transaction';
import { databaseConnectionOf } from '../../src/infrastructure/prisma/database-url';
import {
  classifiedTables,
  MODEL_CLASSIFICATION,
} from '../../src/infrastructure/prisma/model-classification';
import { prismaFor } from '../harness/db';
import {
  createMember,
  createPlayer,
  createTenant,
  testContext,
} from '../harness/fixtures';

// Row-level security (0.4.5). Every statement is raw SQL as the runtime role,
// on a connection of the test's own, so what refuses is PostgreSQL; each
// transaction names its tenant the way withTenantTransaction does (0.4.3), or
// names none. The catalog half holds the database to the classification
// (src/infrastructure/prisma/model-classification.ts).

// A policy's refusal and a missing privilege share a SQLSTATE; the message
// tells them apart.
const INSUFFICIENT_PRIVILEGE = '42501';
const refusedByPolicy = {
  code: INSUFFICIENT_PRIVILEGE,
  message: expect.stringMatching(
    /violates row-level security policy/,
  ) as string,
};
const notPermitted = {
  code: INSUFFICIENT_PRIVILEGE,
  message: expect.stringMatching(/^permission denied/) as string,
};
const TENANT_CHANGE_REFUSED = '23000'; // the tenant_immutable trigger
const NOT_A_UUID = '22P02';

/** The tenant policy's predicate on `column`, as PostgreSQL prints it back. */
const tenantPredicate = (column: string) =>
  `(${column} = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)`;

async function connect(url: string): Promise<Client> {
  const { connectionString, options } = databaseConnectionOf(url);
  const client = new Client({ connectionString, options });
  await client.connect();
  return client;
}

type Done = { rowCount: number; rows: Record<string, unknown>[] };
type Refused = { code?: string; message: string };

describe('row-level security on every tenant-owned table', () => {
  let app: Client;
  let a: Tenant;
  let b: Tenant;
  let memberA: User;
  let playerA: Player;
  let playerB: Player;
  const tables = classifiedTables();
  const guarded = tables.filter((t) => t.tenantColumn !== null);

  /**
   * One statement in a transaction of its own, as `tenant` — a tenant's id, a
   * raw setting such as '' or 'acme', or null for none set at all.
   */
  async function as(
    tenant: string | null,
    sql: string,
    params: unknown[] = [],
  ): Promise<Done | Refused> {
    await app.query('BEGIN');
    try {
      if (tenant !== null) {
        await app.query("SELECT set_config('app.tenant_id', $1, true)", [
          tenant,
        ]);
      }
      const { rowCount, rows } = await app.query<Record<string, unknown>>(
        sql,
        params,
      );
      await app.query('COMMIT');
      return { rowCount: rowCount ?? 0, rows };
    } catch (error) {
      await app.query('ROLLBACK');
      const { code, message } = error as DatabaseError;
      return { code, message };
    }
  }

  /** The rows a statement returned; fails the test if it was refused. */
  async function rowsAs(
    tenant: string | null,
    sql: string,
    params?: unknown[],
  ) {
    const outcome = await as(tenant, sql, params);
    if (!('rows' in outcome)) throw new Error(`refused: ${outcome.message}`);
    return outcome.rows;
  }

  const insertPlayer = (tenant: string | null, owner: Tenant) =>
    as(
      tenant,
      `INSERT INTO players (id, tenant_id, full_name, updated_at)
       VALUES ($1, $2, 'Test Player RLS', now())`,
      [randomUUID(), owner.id],
    );

  beforeAll(async () => {
    app = await connect(inject('databaseUrl'));
    [a, b] = [await createTenant(), await createTenant()];
    memberA = await createMember(a, 'COACH');
    await createMember(b, 'COACH');
    [playerA, playerB] = [await createPlayer(a), await createPlayer(b)];
  });

  afterAll(async () => {
    await app?.end();
  });

  it('rls_missing_context_denies_reads_and_writes', async () => {
    // With no tenant named — never set, or left empty by a finished
    // transaction — every tenant-owned table, and tenants, is empty.
    for (const none of [null, '']) {
      for (const { table } of guarded) {
        expect([
          table,
          await rowsAs(none, `SELECT count(*)::int AS n FROM ${table}`),
        ]).toEqual([table, [{ n: 0 }]]);
      }
      expect(await insertPlayer(none, a)).toEqual(refusedByPolicy);
      expect(
        await as(
          none,
          `UPDATE players SET full_name = 'Renamed' WHERE id = $1`,
          [playerA.id],
        ),
      ).toMatchObject({ rowCount: 0 });
      expect(
        await as(none, 'DELETE FROM players WHERE id = $1', [playerA.id]),
      ).toMatchObject({ rowCount: 0 });
    }
    // A malformed tenant fails the statement rather than matching anything.
    expect(await as('acme', 'SELECT count(*) FROM players')).toMatchObject({
      code: NOT_A_UUID,
    });

    // As tenant A: A's rows, and nothing of B's, read or written.
    const seen = await rowsAs(a.id, 'SELECT id, tenant_id FROM players');
    expect(seen).toContainEqual({ id: playerA.id, tenant_id: a.id });
    expect(seen.every((row) => row.tenant_id === a.id)).toBe(true);
    expect(
      await rowsAs(a.id, 'SELECT id FROM players WHERE id = $1', [playerB.id]),
    ).toEqual([]);
    expect(await rowsAs(a.id, 'SELECT id FROM tenants')).toEqual([
      { id: a.id },
    ]);
    expect(await insertPlayer(a.id, b)).toEqual(refusedByPolicy);
    expect(
      await as(a.id, `UPDATE players SET full_name = 'Renamed' WHERE id = $1`, [
        playerB.id,
      ]),
    ).toMatchObject({ rowCount: 0 });
    expect(
      await as(a.id, 'DELETE FROM players WHERE id = $1', [playerB.id]),
    ).toMatchObject({ rowCount: 0 });

    // Nothing above changed either tenant's player.
    for (const [tenant, player] of [
      [a, playerA],
      [b, playerB],
    ] as const) {
      expect(
        await rowsAs(tenant.id, 'SELECT full_name FROM players WHERE id = $1', [
          player.id,
        ]),
      ).toEqual([{ full_name: player.fullName }]);
    }
    // And A still writes its own rows.
    expect(await insertPlayer(a.id, a)).toMatchObject({ rowCount: 1 });
  });

  it('rls_pool_reuse_never_leaks_the_previous_tenant', async () => {
    // Two connections for twenty-four interleaved transactions of two tenants,
    // A, A, B over and over, so that each connection serves both; each
    // transaction sees its own tenant only.
    const pool = prismaFor(inject('databaseUrl'), { max: 2 });
    try {
      const tenants = new TenantTransactions(pool.prisma);
      const look = Prisma.sql`
        SELECT pg_backend_pid() AS pid,
               current_setting('app.tenant_id', true) AS setting,
               array(SELECT DISTINCT tenant_id::text FROM players) AS seen`;
      type Look = { pid: number; setting: string; seen: string[] };
      const runs = await Promise.all(
        Array.from({ length: 24 }, (_, i) => (i % 3 === 2 ? b : a)).map(
          (tenant) =>
            tenants.withTenantTransaction(
              testContext(tenant.id),
              async (tx) => {
                const [before] = await tx.$queryRaw<Look[]>(look);
                await tx.$executeRaw`SELECT pg_sleep(0.005)`; // let the others interleave
                const [after] = await tx.$queryRaw<Look[]>(look);
                return { tenant, before, after };
              },
            ),
        ),
      );
      for (const { tenant, before, after } of runs) {
        for (const look of [before, after]) {
          expect(look.setting).toBe(tenant.id);
          expect(look.seen).toEqual([tenant.id]);
        }
        expect(after.pid).toBe(before.pid);
      }
      const tenantsOf = new Map<number, Set<string>>();
      for (const { tenant, before } of runs) {
        tenantsOf.set(
          before.pid,
          (tenantsOf.get(before.pid) ?? new Set()).add(tenant.id),
        );
      }
      expect(tenantsOf.size).toBeLessThanOrEqual(2);
      expect([...tenantsOf.values()].some((both) => both.size === 2)).toBe(
        true,
      );

      // After them, on the same connections, no tenant at all.
      for (let i = 0; i < 4; i += 1) {
        const [bare] = await pool.prisma.$queryRaw<Look[]>(look);
        expect(tenantsOf.has(bare.pid)).toBe(true);
        expect(bare.setting ?? '').toBe('');
        expect(bare.seen).toEqual([]);
      }
    } finally {
      await pool.close();
    }

    // One connection: a transaction that fails leaves nothing to the next.
    const single = prismaFor(inject('databaseUrl'), { max: 1 });
    try {
      const tenants = new TenantTransactions(single.prisma);
      await expect(
        tenants.withTenantTransaction(testContext(a.id), async (tx) => {
          await tx.$queryRaw`SELECT 1 FROM players`;
          throw new Error('the use case failed');
        }),
      ).rejects.toThrow('the use case failed');
      const seenByB = await tenants.withTenantTransaction(
        testContext(b.id),
        (tx) => tx.player.findMany({ select: { tenantId: true } }),
      );
      expect(seenByB.length).toBeGreaterThan(0);
      expect(seenByB.every(({ tenantId }) => tenantId === b.id)).toBe(true);
      expect(await single.prisma.player.count()).toBe(0);
    } finally {
      await single.close();
    }
  });

  it('every_tenant_table_has_forced_rls_and_a_policy', async () => {
    // Every model is classified, and nothing else is.
    expect(Object.keys(MODEL_CLASSIFICATION).sort()).toEqual(
      Prisma.dmmf.datamodel.models.map((m) => m.name).sort(),
    );
    // A model is tenant-owned exactly when it has a tenantId.
    for (const model of Prisma.dmmf.datamodel.models) {
      const tenantOwned = model.fields.some((f) => f.name === 'tenantId');
      expect([
        model.name,
        MODEL_CLASSIFICATION[model.name as Prisma.ModelName].kind,
      ]).toEqual([model.name, tenantOwned ? 'tenant-owned' : 'global']);
    }

    // Every table with a tenant_id column is a tenant-owned model's.
    const { rows: withTenantId } = await app.query<{ table: string }>(
      `SELECT c.relname AS table FROM pg_class c
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
        WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind IN ('r', 'p')
        ORDER BY 1`,
    );
    expect(withTenantId.map((row) => row.table)).toEqual(
      tables
        .filter((t) => t.class.kind === 'tenant-owned')
        .map((t) => t.table)
        .sort(),
    );

    // Those tables and tenants: forced row-level security and exactly two
    // policies, the runtime role's on its tenant and the owner's read.
    const { rows: secured } = await app.query<{
      table: string;
      enabled: boolean;
      forced: boolean;
    }>(
      `SELECT relname AS table, relrowsecurity AS enabled, relforcerowsecurity AS forced
         FROM pg_class WHERE relnamespace = current_schema()::regnamespace
          AND relkind IN ('r', 'p', 'v') AND (relrowsecurity OR relforcerowsecurity)
        ORDER BY 1`,
    );
    expect(secured).toEqual(
      guarded
        .map((t) => ({ table: t.table, enabled: true, forced: true }))
        .sort((x, y) => (x.table < y.table ? -1 : 1)),
    );
    const { rows: policies } = await app.query<{
      table: string;
      name: string;
      permissive: string;
      roles: string[];
      cmd: string;
      qual: string;
      withCheck: string | null;
    }>(
      `SELECT tablename AS table, policyname AS name, permissive, roles::text[] AS roles,
              cmd, qual, with_check AS "withCheck"
         FROM pg_policies WHERE schemaname = current_schema()
        ORDER BY tablename, policyname`,
    );
    expect(policies).toEqual(
      guarded
        .slice()
        .sort((x, y) => (x.table < y.table ? -1 : 1))
        .flatMap(({ table, tenantColumn }) => [
          {
            table,
            name: `${table}_owner_reads`,
            permissive: 'PERMISSIVE',
            roles: ['sadara_owner'],
            cmd: 'SELECT',
            qual: 'true',
            withCheck: null,
          },
          {
            table,
            name: `${table}_tenant`,
            permissive: 'PERMISSIVE',
            roles: ['sadara_app'],
            cmd: 'ALL',
            qual: tenantPredicate(tenantColumn!),
            withCheck: tenantPredicate(tenantColumn!),
          },
        ]),
    );

    // The runtime role's privileges, table by table: data rights on a
    // tenant's tables, reading reference data, nothing on migration history.
    const privileges = async (table: string) =>
      (
        await app.query<{ granted: string[] }>(
          `SELECT array(SELECT p FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p
                          WHERE has_table_privilege('sadara_app', $1::regclass, p)) AS granted`,
          [table],
        )
      ).rows[0].granted;
    for (const { table, class: modelClass } of tables) {
      const expected =
        modelClass.kind === 'global' && modelClass.runtime === 'read-only'
          ? ['SELECT']
          : ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
      expect([table, await privileges(table)]).toEqual([table, expected]);
    }
    expect(await privileges('_prisma_migrations')).toEqual([]);
  });

  it('tenant_ids_cannot_be_updated', async () => {
    // Every guarded table has the trigger, enabled, on the column it guards,
    // and the schema has no other trigger of its own.
    const schema = inject('databaseSchema');
    const { rows: triggers } = await app.query<{
      table: string;
      enabled: string;
      definition: string;
    }>(
      `SELECT c.relname AS table, t.tgenabled AS enabled,
              pg_get_triggerdef(t.oid) AS definition
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE c.relnamespace = current_schema()::regnamespace AND NOT t.tgisinternal
        ORDER BY 1`,
    );
    expect(triggers).toEqual(
      guarded
        .slice()
        .sort((x, y) => (x.table < y.table ? -1 : 1))
        .map(({ table, tenantColumn: column }) => ({
          table,
          enabled: 'O',
          definition:
            `CREATE TRIGGER ${table}_tenant_immutable BEFORE UPDATE ON ${schema}.${table} ` +
            `FOR EACH ROW WHEN ((old.${column} IS DISTINCT FROM new.${column})) ` +
            `EXECUTE FUNCTION refuse_tenant_change('${column}')`,
        })),
    );

    // As tenant A, moving A's own rows: the trigger refuses before the policy
    // would (a policy refusal is 42501), and names no value.
    const moves: Array<[string, string, unknown[]]> = [
      [
        'players',
        'UPDATE players SET tenant_id = $1 WHERE id = $2',
        [b.id, playerA.id],
      ],
      [
        'users',
        'UPDATE users SET tenant_id = $1 WHERE id = $2',
        [b.id, memberA.id],
      ],
      [
        'tenants',
        'UPDATE tenants SET id = $1 WHERE id = $2',
        [randomUUID(), a.id],
      ],
    ];
    for (const [table, sql, params] of moves) {
      const column = table === 'tenants' ? 'id' : 'tenant_id';
      expect(await as(a.id, sql, params)).toEqual({
        code: TENANT_CHANGE_REFUSED,
        message: `${table}.${column} cannot change: a row stays with its tenant`,
      });
    }
    expect(
      await rowsAs(a.id, 'SELECT tenant_id FROM players WHERE id = $1', [
        playerA.id,
      ]),
    ).toEqual([{ tenant_id: a.id }]);

    // Writing the same tenant back is no change, and passes.
    expect(
      await as(a.id, 'UPDATE users SET tenant_id = $1 WHERE id = $2', [
        a.id,
        memberA.id,
      ]),
    ).toMatchObject({ rowCount: 1 });
  });

  it('the_tenant_directory_exposes_only_routing_columns', async () => {
    const { rows: columns } = await app.query<{ column: string }>(
      `SELECT column_name AS column FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'tenant_directory'
        ORDER BY ordinal_position`,
    );
    expect(columns.map((c) => c.column)).toEqual([
      'id',
      'slug',
      'domain',
      'is_active',
    ]);

    // With no tenant, as before anyone signs in: every tenant's routing
    // columns, and nothing more of any of them.
    const listed = await rowsAs(
      null,
      'SELECT * FROM tenant_directory WHERE id = ANY($1::uuid[]) ORDER BY slug',
      [[a.id, b.id]],
    );
    expect(listed).toEqual(
      [a, b]
        .sort((x, y) => (x.slug < y.slug ? -1 : 1))
        .map(({ id, slug, domain, isActive }) => ({
          id,
          slug,
          domain,
          is_active: isActive,
        })),
    );
    // The full row is its own tenant's alone.
    expect(
      await rowsAs(null, 'SELECT id FROM tenants WHERE id = ANY($1::uuid[])', [
        [a.id, b.id],
      ]),
    ).toEqual([]);
    expect(
      await rowsAs(a.id, 'SELECT id FROM tenants WHERE id = ANY($1::uuid[])', [
        [a.id, b.id],
      ]),
    ).toEqual([{ id: a.id }]);

    // The runtime role reads the view and writes nothing through it.
    for (const sql of [
      `UPDATE tenant_directory SET slug = 'renamed' WHERE id = '${a.id}'`,
      `DELETE FROM tenant_directory WHERE id = '${b.id}'`,
      `INSERT INTO tenant_directory (id, slug) VALUES ('${randomUUID()}', 'probe')`,
    ]) {
      expect([sql, await as(a.id, sql)]).toEqual([sql, notPermitted]);
    }
  });
});
