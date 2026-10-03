// Preflight (0.4.1): a read-only report of every integrity violation, run
// before every constraint migration and before any data migration. The rules
// are scripts/preflight.sql; this runs them in one READ ONLY transaction and
// prints {schemaVersion, inspectedAt, counts, violations, unknowns}
// (docs/reference/database.md). A violation blocks the migration that depends
// on it until the data is corrected; nothing is ever deleted to let a
// constraint pass. Unknowns inform, and do not block.
//   just preflight    report on DATABASE_URL; exits 1 on any violation
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

/** Each currency's minor units, from ISO 4217 as Intl carries it. */
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

    const currencies: string[] = (await exists(client, 'type', '"Currency"'))
      ? (
          await client.query<{ code: string }>(
            `SELECT unnest(enum_range(NULL::"Currency"))::text AS code`,
          )
        ).rows.map(({ code }) => code)
      : [];
    await client.query(
      "SELECT set_config('sadara.currency_exponents', $1, true)",
      [JSON.stringify(exponentsOf(currencies))],
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
      for (const query of queries) {
        if (kind.endsWith('violations')) {
          report.counts[rule] ??= 0;
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
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    process.stderr.write('preflight: DATABASE_URL is not set\n');
    process.exit(2);
  }
  const report = await runPreflight(databaseUrl);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.violations.length > 0 ? 1 : 0);
}

if (process.argv[1]?.endsWith('preflight.ts')) void main();
