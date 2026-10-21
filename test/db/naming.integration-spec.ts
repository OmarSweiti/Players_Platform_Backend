import type { PrismaClient } from '@prisma/client';
import { describe, expect, inject, it } from 'vitest';
import { runPrisma } from '../harness/fixtures';

// One naming scheme in the database (0.4.0, DB-49): every name is lower
// snake_case, so no SQL statement has to quote one. Prisma maps each field
// and enum to it (`@map`, `@@map`); a field added without its `@map` fails
// here. Prisma's own bookkeeping table, `_prisma_migrations`, is not ours.
const SNAKE_CASE = '^[a-z][a-z0-9]*(_[a-z0-9]+)*$';

/** Every name in `schema` that is not lower snake_case, as `<kind> <name>`. */
async function namesNotInSnakeCase(
  prisma: Pick<PrismaClient, '$queryRawUnsafe'>,
  schema: string,
): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<{ name: string }[]>(
    `WITH ns AS (SELECT oid FROM pg_namespace WHERE nspname = $1),
     ours AS (
       SELECT c.oid FROM pg_class c, ns
       WHERE c.relnamespace = ns.oid AND c.relname <> '_prisma_migrations'
     ),
     names (kind, name) AS (
       SELECT CASE c.relkind WHEN 'i' THEN 'index' WHEN 'I' THEN 'index'
                             WHEN 'S' THEN 'sequence' WHEN 'v' THEN 'view'
                             WHEN 'm' THEN 'view' WHEN 'c' THEN 'type'
                             ELSE 'table' END,
              c.relname
       FROM pg_class c JOIN ours USING (oid)
       WHERE c.relname <> '_prisma_migrations_pkey'
       UNION ALL
       SELECT 'column', c.relname || '.' || a.attname
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN ours ON ours.oid = c.oid
       WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'c')
       UNION ALL
       SELECT 'type', t.typname FROM pg_type t, ns
       WHERE t.typnamespace = ns.oid AND t.typrelid = 0 AND t.typcategory <> 'A'
       UNION ALL
       SELECT 'constraint', k.conname FROM pg_constraint k, ns
       WHERE k.connamespace = ns.oid AND k.conrelid IN (SELECT oid FROM ours UNION SELECT 0)
       UNION ALL
       SELECT 'function', p.proname FROM pg_proc p, ns WHERE p.pronamespace = ns.oid
       UNION ALL
       SELECT 'trigger', g.tgname FROM pg_trigger g JOIN ours ON ours.oid = g.tgrelid
       WHERE NOT g.tgisinternal
       UNION ALL
       SELECT 'policy', y.polname FROM pg_policy y JOIN ours ON ours.oid = y.polrelid
     )
     SELECT kind || ' ' || name AS name FROM names
     WHERE (kind = 'column' AND split_part(name, '.', 2) !~ $2)
        OR (kind <> 'column' AND name !~ $2)
     ORDER BY (kind || ' ' || name) COLLATE "C"`,
    schema,
    SNAKE_CASE,
  );
  return rows.map(({ name }) => name);
}

class RolledBack extends Error {}

describe('database names', () => {
  it('every_database_name_is_lower_snake_case', async () => {
    const schema = inject('databaseSchema');

    expect(await namesNotInSnakeCase(runPrisma(), schema)).toEqual([]);
  });

  it('a camelCase name anywhere is refused', async () => {
    const schema = inject('databaseSchema');
    let found: string[] = [];

    // Made inside a transaction that never commits: the schema stays as the
    // migrations left it.
    await runPrisma()
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'CREATE TABLE "probeTable" (id int CONSTRAINT "probeTable_pkey" PRIMARY KEY, "createdAt" date NOT NULL)',
        );
        await tx.$executeRawUnsafe(
          'CREATE INDEX "probeTable_createdAt_idx" ON "probeTable" ("createdAt")',
        );
        await tx.$executeRawUnsafe(
          `CREATE TYPE "ProbeStatus" AS ENUM ('OPEN')`,
        );
        found = await namesNotInSnakeCase(tx, schema);
        throw new RolledBack();
      })
      .catch((error: unknown) => {
        if (!(error instanceof RolledBack)) throw error;
      });

    expect(found).toEqual([
      'column probeTable.createdAt',
      'constraint probeTable_createdAt_not_null',
      'constraint probeTable_id_not_null', // PostgreSQL 18 names a key's NOT NULL too
      'constraint probeTable_pkey',
      'index probeTable_createdAt_idx',
      'index probeTable_pkey',
      'table probeTable',
      'type ProbeStatus',
    ]);
  });
});
