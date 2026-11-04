import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { databaseConnectionOf } from '../../src/infrastructure/prisma/database-url';

// The indexes (0.4.6; SR-DB-006, DB-39, DB-40, DB-54), read from the catalog of
// this run's schema as the runtime role. Under row-level security every query
// on a tenant-owned table filters on tenant_id, so an index that does not lead
// with it scans every tenant's entries first.

/**
 * Uniqueness rules on a tenant-owned table that lead with a parent's id rather
 * than tenant_id. Each is tenant-safe: the parent's id is unique across
 * tenants, and the row's composite key (0.4.4) ties that parent to the row's
 * own tenant. Leading with tenant_id would change nothing they enforce, and
 * would rename the compound keys the code addresses them by.
 */
const LEADS_WITH_A_PARENT: Record<string, string> = {
  attendance_enrollment_id_training_session_id_key:
    'one attendance row per enrollment and session',
  contract_approvals_contract_id_approved_by_id_key:
    'one approval per contract and approver',
  contract_versions_contract_id_version_key: 'one version number per contract',
  conversation_members_conversation_id_user_id_key:
    'one membership per conversation and member',
  enrollments_training_id_player_id_key:
    'one enrollment per programme and player',
  player_watchlists_user_id_player_id_key:
    "one watchlist entry per member and player (the watchlist repository's userId_playerId)",
};

interface Index {
  table: string;
  name: string;
  unique: boolean;
  columns: string[];
  predicate: string | null;
  tenantOwned: boolean;
}

interface ForeignKey {
  table: string;
  name: string;
  columns: string[];
  /** The column that names the parent row's id. */
  parentIdColumn: string;
}

async function connect(url: string): Promise<Client> {
  const { connectionString, options } = databaseConnectionOf(url);
  const client = new Client({ connectionString, options });
  await client.connect();
  return client;
}

describe('the indexes', () => {
  let app: Client;
  let indexes: Index[];
  let keys: ForeignKey[];

  beforeAll(async () => {
    app = await connect(inject('databaseUrl'));
    indexes = (
      await app.query<Index>(
        `SELECT t.relname AS table, i.relname AS name, x.indisunique AS unique,
                ARRAY(SELECT a.attname::text FROM unnest(x.indkey) WITH ORDINALITY AS k(n, o)
                        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.n
                       ORDER BY k.o) AS columns,
                pg_get_expr(x.indpred, x.indrelid) AS predicate,
                EXISTS (SELECT FROM pg_attribute a
                         WHERE a.attrelid = t.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
                  AS "tenantOwned"
           FROM pg_index x
           JOIN pg_class i ON i.oid = x.indexrelid
           JOIN pg_class t ON t.oid = x.indrelid
          WHERE t.relnamespace = current_schema()::regnamespace AND t.relkind IN ('r', 'p')
            AND t.relname <> '_prisma_migrations' AND x.indisvalid
          ORDER BY 1, 2`,
      )
    ).rows;
    keys = (
      await app.query<ForeignKey>(
        `SELECT c.conrelid::regclass::text AS table, c.conname AS name,
                ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY AS k(n, o)
                        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n
                       ORDER BY k.o) AS columns,
                (SELECT a.attname::text FROM unnest(c.conkey, c.confkey) AS k(child, parent)
                   JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.child
                   JOIN pg_attribute p ON p.attrelid = c.confrelid AND p.attnum = k.parent
                  WHERE p.attname = 'id') AS "parentIdColumn"
           FROM pg_constraint c
          WHERE c.contype = 'f' AND c.connamespace = current_schema()::regnamespace
          ORDER BY 1, 2`,
      )
    ).rows;
  });

  afterAll(async () => {
    await app?.end();
  });

  it('every_index_on_a_tenant_table_leads_with_tenant_id', () => {
    const onTenantTables = indexes.filter((index) => index.tenantOwned);
    expect(onTenantTables.length).toBeGreaterThan(0);

    // tenant_id first; or the row's own id (the primary key, and the unique
    // keys composite foreign keys reference), which names one row whatever its
    // tenant; or a reviewed uniqueness rule over a parent's id.
    const leadingElsewhere = onTenantTables
      .filter(({ columns: [first] }) => first !== 'tenant_id' && first !== 'id')
      .map(({ name }) => name);
    expect(leadingElsewhere).toEqual(Object.keys(LEADS_WITH_A_PARENT).sort());

    // The allowlist stays true: each entry is a uniqueness rule that exists.
    for (const name of Object.keys(LEADS_WITH_A_PARENT)) {
      expect([
        name,
        indexes.find((index) => index.name === name)?.unique,
      ]).toEqual([name, true]);
    }
  });

  it('every_foreign_key_is_served_by_an_index', () => {
    // PostgreSQL checks a key from the child's side (a parent deleted or
    // re-keyed) with equality on every key column. An index serves the key
    // when every column it leads with, up to and including the one that names
    // the parent's id, is a key column: the parent's id is unique, so that
    // prefix finds exactly the rows that name it.
    const serves = (index: Index, key: ForeignKey) => {
      const at = index.columns.indexOf(key.parentIdColumn);
      return (
        at >= 0 &&
        index.predicate === null &&
        index.columns.slice(0, at + 1).every((c) => key.columns.includes(c))
      );
    };
    expect(keys.length).toBeGreaterThan(60);
    const unserved = keys
      .filter(
        (key) =>
          !indexes.some(
            (index) => index.table === key.table && serves(index, key),
          ),
      )
      .map(({ name }) => name);
    expect(unserved).toEqual([]);
  });

  it('no_index_repeats_the_leading_columns_of_another', () => {
    // A plain index whose columns open another index on the same table, under
    // the same predicate, costs every write and serves no query the other does
    // not. A unique index is never redundant: it enforces its rule.
    const opens = (short: Index, long: Index) =>
      short !== long &&
      short.table === long.table &&
      short.predicate === long.predicate &&
      short.columns.length <= long.columns.length &&
      short.columns.every((column, i) => long.columns[i] === column);
    const redundant = indexes
      .filter((index) => !index.unique)
      .flatMap((index) =>
        indexes
          .filter((other) => opens(index, other))
          .map((other) => `${index.name} opens ${other.name}`),
      );
    expect(redundant).toEqual([]);
  });
});
