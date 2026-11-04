// Row-level security from the model classification (0.4.5; ADR-0004): prints
// the SQL that gives each named model's table its policies, its tenant-id
// trigger and its runtime privileges, for a migration to carry as printed.
// The tenant_rls migration carries every model's; a later migration that
// creates a table runs this for its model and appends the output after its
// CREATE TABLE (.claude/rules/migrations.md).
//   npx --no-install ts-node --transpile-only scripts/generate-rls.ts [Model …]
// With no model named, it prints every classified model's, in the schema's
// order. test/db/rls.integration-spec.ts holds the database to the same rules.
import {
  classifiedTables,
  type ClassifiedTable,
} from '../src/infrastructure/prisma/model-classification';

export const RUNTIME_ROLE = 'sadara_app';
export const OWNER_ROLE = 'sadara_owner';

/** The tenant of the current transaction: null when none is set, so no row matches. */
export const CURRENT_TENANT = `NULLIF(current_setting('app.tenant_id', true), '')::uuid`;

/** The statements for one table, after a comment naming what they do. */
export function rlsFor({
  table,
  class: modelClass,
  tenantColumn,
}: ClassifiedTable): string {
  if (tenantColumn === null) {
    return [
      `-- ${table}: reference data the migrations write; the runtime role reads it.`,
      `REVOKE INSERT, UPDATE, DELETE ON ${table} FROM ${RUNTIME_ROLE};`,
    ].join('\n');
  }
  const whose =
    modelClass.kind === 'tenant-owned'
      ? `one tenant's rows, by ${tenantColumn}`
      : `each tenant sees and writes its own row`;
  return [
    `-- ${table}: ${whose}.`,
    `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`,
    `CREATE POLICY ${table}_tenant ON ${table} FOR ALL TO ${RUNTIME_ROLE}`,
    `  USING (${tenantColumn} = ${CURRENT_TENANT})`,
    `  WITH CHECK (${tenantColumn} = ${CURRENT_TENANT});`,
    `CREATE POLICY ${table}_owner_reads ON ${table} FOR SELECT TO ${OWNER_ROLE} USING (true);`,
    `CREATE TRIGGER ${table}_tenant_immutable BEFORE UPDATE ON ${table}`,
    `  FOR EACH ROW WHEN (OLD.${tenantColumn} IS DISTINCT FROM NEW.${tenantColumn})`,
    `  EXECUTE FUNCTION refuse_tenant_change('${tenantColumn}');`,
  ].join('\n');
}

/** The SQL for the named models, or for every model when none is named. */
export function generateRls(models: string[] = []): string {
  const tables = classifiedTables();
  const unknown = models.filter(
    (name) => !tables.some((t) => t.model === name),
  );
  if (unknown.length > 0) {
    throw new Error(`not a classified model: ${unknown.join(', ')}`);
  }
  return tables
    .filter((t) => models.length === 0 || models.includes(t.model))
    .map(rlsFor)
    .join('\n\n');
}

function main(): void {
  try {
    process.stdout.write(`${generateRls(process.argv.slice(2))}\n`);
  } catch (error) {
    process.stderr.write(`generate-rls: ${(error as Error).message}\n`);
    process.exit(2);
  }
}

if (process.argv[1]?.endsWith('generate-rls.ts')) main();
