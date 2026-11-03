import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { databaseConnectionOf } from '../../src/infrastructure/prisma/database-url';
import { createTenant, runPrisma } from '../harness/fixtures';

// The runtime role (0.4.2; scripts/database-roles.sql): what the API, the
// worker and these tests connect as. Every assertion runs as that role, on a
// connection of its own, in this run's schema; the migrator only builds the
// probe the row-level-security test needs.

async function connect(url: string): Promise<Client> {
  const { connectionString, options } = databaseConnectionOf(url);
  const client = new Client({ connectionString, options });
  await client.connect();
  return client;
}

/** The SQLSTATE a statement fails with, or 'succeeded'. */
async function outcomeOf(client: Client, sql: string): Promise<string> {
  try {
    await client.query(sql);
    return 'succeeded';
  } catch (error) {
    return (error as { code?: string }).code ?? 'failed without a code';
  }
}

const INSUFFICIENT_PRIVILEGE = '42501';

describe('the runtime role', () => {
  let app: Client;

  beforeAll(async () => {
    app = await connect(inject('databaseUrl'));
  });

  afterAll(async () => {
    await app?.end();
  });

  it('the_runtime_role_owns_no_table', async () => {
    const schema = inject('databaseSchema');

    const { rows } = await app.query<{
      role: string;
      relations: number;
      owned: number;
      schemaOwner: string;
      memberOfOwner: boolean;
      memberOfMigrator: boolean;
    }>(
      `SELECT current_user AS role,
              (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'S')) AS relations,
              (SELECT count(*)::int FROM pg_class c
                WHERE c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)) AS owned,
              (SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname = $1) AS "schemaOwner",
              pg_has_role(current_user, 'sadara_owner', 'MEMBER') AS "memberOfOwner",
              pg_has_role(current_user, 'sadara_migrator', 'MEMBER') AS "memberOfMigrator"`,
      [schema],
    );

    expect(rows[0]).toEqual({
      role: 'sadara_app',
      relations: expect.any(Number) as number,
      owned: 0, // in any schema of the database, not only this run's
      schemaOwner: 'sadara_owner',
      memberOfOwner: false,
      memberOfMigrator: false,
    });
    expect(rows[0].relations).toBeGreaterThan(0); // the migrated tables are there
  });

  it('the_runtime_role_cannot_run_ddl', async () => {
    // Data is the runtime role's: it writes and reads two tenants' rows.
    const tenants = [await createTenant(), await createTenant()];
    const seen = await runPrisma().tenant.count({
      where: { id: { in: tenants.map(({ id }) => id) } },
    });
    expect(seen).toBe(2);

    const refused = {
      'CREATE TABLE probe_ddl (id int)': INSUFFICIENT_PRIVILEGE,
      'ALTER TABLE players ADD COLUMN probe int': INSUFFICIENT_PRIVILEGE,
      'CREATE INDEX ON players (full_name)': INSUFFICIENT_PRIVILEGE,
      'DROP TABLE players': INSUFFICIENT_PRIVILEGE,
      'TRUNCATE players': INSUFFICIENT_PRIVILEGE,
      'CREATE SCHEMA probe_ddl': INSUFFICIENT_PRIVILEGE,
      'SET ROLE sadara_owner': INSUFFICIENT_PRIVILEGE,
    };
    const seenOutcomes: Record<string, string> = {};
    for (const sql of Object.keys(refused)) {
      seenOutcomes[sql] = await outcomeOf(app, sql);
    }
    expect(seenOutcomes).toEqual(refused);

    // A grant from a role without the grant option is no error in PostgreSQL —
    // it warns and grants nothing — so what counts is the table's ACL after it.
    await app.query('GRANT SELECT ON players TO PUBLIC');
    const { rows } = await app.query<{
      publicGrants: number;
      grantable: boolean;
    }>(
      `SELECT (SELECT count(*)::int FROM pg_class c, aclexplode(c.relacl) acl
                WHERE c.oid = 'players'::regclass AND acl.grantee = 0) AS "publicGrants",
              has_table_privilege('players', 'SELECT WITH GRANT OPTION') AS grantable`,
    );
    expect(rows[0]).toEqual({ publicGrants: 0, grantable: false });
  });

  it('the_runtime_role_cannot_bypass_rls', async () => {
    const { rows } = await app.query<{ super: boolean; bypass: boolean }>(
      `SELECT rolsuper AS super, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`,
    );
    expect(rows[0]).toEqual({ super: false, bypass: false });

    // A table with row-level security and no policy: its owner sees the row,
    // anyone else sees nothing — and may not switch the policies off.
    const migrator = await connect(inject('migrationDatabaseUrl'));
    try {
      await migrator.query(`CREATE TABLE rls_probe (id int PRIMARY KEY)`);
      await migrator.query(`ALTER TABLE rls_probe ENABLE ROW LEVEL SECURITY`);
      await migrator.query(`INSERT INTO rls_probe VALUES (1)`);

      const visible = await app.query<{ rows: number }>(
        `SELECT count(*)::int AS rows FROM rls_probe`,
      );
      expect(visible.rows[0].rows).toBe(0);

      await app.query(`SET row_security = off`);
      expect(await outcomeOf(app, `SELECT * FROM rls_probe`)).toBe(
        INSUFFICIENT_PRIVILEGE, // "query would be affected by row-level security policy"
      );
    } finally {
      await app.query(`RESET row_security`);
      await migrator.query(`DROP TABLE IF EXISTS rls_probe`);
      await migrator.end();
    }
  });

  it('the_runtime_role_has_bounded_work', async () => {
    // A fresh connection: what every session of the role starts with, set on
    // the role itself (source "user"), not by any client.
    const fresh = await connect(inject('databaseUrl'));
    try {
      const { rows } = await fresh.query<{
        name: string;
        value: string;
        source: string;
      }>(
        `SELECT name, current_setting(name) AS value, source FROM pg_settings
          WHERE name IN ('statement_timeout', 'lock_timeout',
                         'idle_in_transaction_session_timeout', 'TimeZone')
          ORDER BY name`, // C.UTF-8 (DB-51) orders by code point: capitals first
      );
      expect(rows).toEqual([
        { name: 'TimeZone', value: 'UTC', source: 'user' },
        {
          name: 'idle_in_transaction_session_timeout',
          value: '1min',
          source: 'user',
        },
        { name: 'lock_timeout', value: '5s', source: 'user' },
        { name: 'statement_timeout', value: '15s', source: 'user' },
      ]);

      // A statement past its limit is cancelled, not left running.
      await fresh.query('BEGIN');
      await fresh.query(`SET LOCAL statement_timeout = '100ms'`);
      expect(await outcomeOf(fresh, 'SELECT pg_sleep(2)')).toBe('57014'); // query_canceled
      await fresh.query('ROLLBACK');
    } finally {
      await fresh.end();
    }
  });
});
