// Preflight (0.4.1): a read-only report of every integrity violation, run
// before every constraint migration and before any data migration. The rules
// are scripts/preflight.sql; this runs them in one READ ONLY transaction and
// prints {schemaVersion, inspectedAt, counts, violations, unknowns}
// (docs/reference/database.md). A violation blocks the migration that depends
// on it until the data is corrected; nothing is ever deleted to let a
// constraint pass. Unknowns inform, and do not block.
//
// It runs as the migrator (MIGRATION_DATABASE_URL), which acts as the tables'
// owner. Row-level security (0.4.5) shows the runtime role one tenant's rows at
// most, so a report made as it would be clean whatever the data held; the
// owner reads every tenant's rows through each table's read policy. A role the
// policies hide rows from is refused before any rule runs.
//   just preflight    report on MIGRATION_DATABASE_URL; exits 1 on any violation
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { databaseConnectionOf } from '../src/infrastructure/prisma/database-url';

export interface Violation {
  rule: string;
  table: string;
  rowId: string;
  tenantId: string;
  reason: string;
}

export interface Unknown {
  rule: string;
  table: string;
  column: string;
  count: number;
  reason: string;
}

export interface PreflightReport {
  /** The last migration applied to the inspected schema. */
  schemaVersion: string | null;
  inspectedAt: string;
  /** Violations per rule, every rule listed, zeros included. */
  counts: Record<string, number>;
  violations: Violation[];
  unknowns: Unknown[];
}

type SectionKind =
  'violations' | 'unknowns' | 'generate violations' | 'generate unknowns';

interface Section {
  kind: SectionKind;
  rule: string;
  sql: string;
}

const HEADER =
  /^-- (violations|unknowns|generate violations|generate unknowns): (\w+)$/;

/** The sections of preflight.sql, in order. */
function sectionsOf(source: string): Section[] {
  const sections: Section[] = [];
  for (const line of source.split('\n')) {
    const header = HEADER.exec(line);
    if (header) {
      sections.push({
        kind: header[1] as SectionKind,
        rule: header[2],
        sql: '',
      });
    } else if (sections.length > 0) {
      sections[sections.length - 1].sql += `${line}\n`;
    }
  }
  return sections;
}

/**
 * Each currency's minor units, from ISO 4217 as Intl carries it: for a
 * database from before 0.4.7, whose currencies are a four-value enum.
 */
function exponentsOf(currencies: string[]): Record<string, number> {
  const exponents: Record<string, number> = {};
  for (const currency of currencies) {
    try {
      exponents[currency] = new Intl.NumberFormat('en', {
        style: 'currency',
        currency,
      }).resolvedOptions().maximumFractionDigits!;
    } catch {
      // Not an ISO 4217 code: its amounts are not checked against minor units.
    }
  }
  return exponents;
}

interface ViolationRow {
  table_name: string;
  row_id: string;
  tenant_id: string;
  reason: string;
}

interface UnknownRow {
  table_name: string;
  column_name: string;
  count: string | number;
  reason: string;
}

/** The inspecting role cannot see every row: a report made as it would be false. */
export class PreflightRefused extends Error {}

/**
 * The tables under row-level security whose rows the connected role cannot
 * all read: those it neither bypasses (superuser, BYPASSRLS, an owner the
 * table does not FORCE) nor reads through a permissive policy of `true`.
 */
const HIDDEN_FROM_ME = `
  SELECT c.relname AS table_name
  FROM pg_class c
  WHERE c.relnamespace = current_schema()::regnamespace
    AND c.relkind IN ('r', 'p')
    AND c.relrowsecurity
    AND NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user)
    AND NOT (NOT c.relforcerowsecurity AND pg_has_role(current_user, c.relowner, 'USAGE'))
    AND NOT EXISTS (
      SELECT FROM pg_policy p
      WHERE p.polrelid = c.oid AND p.polpermissive AND p.polcmd IN ('r', '*')
        AND pg_get_expr(p.polqual, p.polrelid) = 'true'
        AND EXISTS (SELECT FROM unnest(p.polroles) AS r(oid)
                    WHERE r.oid = 0 OR pg_has_role(current_user, r.oid, 'USAGE')))
  ORDER BY 1`;

export async function runPreflight(
  databaseUrl: string,
): Promise<PreflightReport> {
  const { connectionString, schema } = databaseConnectionOf(databaseUrl);
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '60s'");
    if (schema) {
      await client.query(
        "SELECT set_config('search_path', quote_ident($1), true)",
        [schema],
      );
    }

    const hidden = (
      await client.query<{ table_name: string }>(HIDDEN_FROM_ME)
    ).rows.map((row) => row.table_name);
    if (hidden.length > 0) {
      const { rows } = await client.query<{ role: string }>(
        'SELECT current_user AS role',
      );
      throw new PreflightRefused(
        `row-level security hides rows of ${hidden.join(', ')} from ${rows[0].role}, ` +
          'so a report would miss them: the preflight runs as the migrator ' +
          '(MIGRATION_DATABASE_URL), and each table needs its owner read policy',
      );
    }

    await client.query(
      "SELECT set_config('sadara.currency_exponents', $1, true)",
      [JSON.stringify(await currencyExponents(client))],
    );

    const report: PreflightReport = {
      schemaVersion: await lastMigration(client),
      inspectedAt: new Date().toISOString(),
      counts: {},
      violations: [],
      unknowns: [],
    };

    const source = readFileSync(join(__dirname, 'preflight.sql'), 'utf8');
    for (const { kind, rule, sql } of sectionsOf(source)) {
      const queries = kind.startsWith('generate')
        ? (await client.query<{ sql: string }>(sql)).rows.map((r) => r.sql)
        : [sql];
      // Listed even when the catalog gives a generated rule nothing to check:
      // since 0.4.4 no single-column key crosses tenants, and that is a zero.
      if (kind.endsWith('violations')) report.counts[rule] ??= 0;
      for (const query of queries) {
        if (kind.endsWith('violations')) {
          for (const row of (await client.query<ViolationRow>(query)).rows) {
            report.violations.push({
              rule,
              table: row.table_name,
              rowId: row.row_id,
              tenantId: row.tenant_id,
              reason: row.reason,
            });
            report.counts[rule] += 1;
          }
        } else {
          for (const row of (await client.query<UnknownRow>(query)).rows) {
            report.unknowns.push({
              rule,
              table: row.table_name,
              column: row.column_name,
              count: Number(row.count),
              reason: row.reason,
            });
          }
        }
      }
    }
    return report;
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  }
}

/**
 * The minor units of each currency an amount may carry: the database's own
 * currency_definitions (0.4.7), or before it, the old enum's codes.
 */
async function currencyExponents(
  client: Client,
): Promise<Record<string, number>> {
  if (await exists(client, 'relation', 'currency_definitions')) {
    const { rows } = await client.query<{ code: string; exponent: number }>(
      'SELECT code, minor_unit_exponent AS exponent FROM currency_definitions',
    );
    return Object.fromEntries(
      rows.map(({ code, exponent }) => [code, exponent]),
    );
  }
  if (!(await exists(client, 'type', 'currency'))) return {};
  const { rows } = await client.query<{ code: string }>(
    'SELECT unnest(enum_range(NULL::currency))::text AS code',
  );
  return exponentsOf(rows.map(({ code }) => code));
}

/** Whether a relation or type exists in the inspected schema. */
async function exists(
  client: Client,
  kind: 'relation' | 'type',
  name: string,
): Promise<boolean> {
  const lookup = kind === 'relation' ? 'to_regclass' : 'to_regtype';
  const { rows } = await client.query<{ found: boolean }>(
    `SELECT ${lookup}($1) IS NOT NULL AS found`,
    [name],
  );
  return rows[0].found;
}

async function lastMigration(client: Client): Promise<string | null> {
  if (!(await exists(client, 'relation', '_prisma_migrations'))) return null;
  const { rows } = await client.query<{ name: string }>(
    `SELECT migration_name AS name FROM _prisma_migrations
     WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
     ORDER BY finished_at DESC, migration_name DESC LIMIT 1`,
  );
  return rows[0]?.name ?? null;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.MIGRATION_DATABASE_URL;
  if (!databaseUrl) {
    process.stderr.write('preflight: MIGRATION_DATABASE_URL is not set\n');
    process.exit(2);
  }
  let report: PreflightReport;
  try {
    report = await runPreflight(databaseUrl);
  } catch (error) {
    if (!(error instanceof PreflightRefused)) throw error;
    process.stderr.write(`preflight: REFUSED — ${error.message}\n`);
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.violations.length > 0 ? 1 : 0);
}

if (process.argv[1]?.endsWith('preflight.ts')) void main();
