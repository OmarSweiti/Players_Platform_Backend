/**
 * Splits a PostgreSQL URL into what `pg` connects with and the schema Prisma
 * must name in its queries. With a driver adapter, Prisma qualifies every table
 * with a schema (`public` unless told otherwise), so pointing the connection at
 * another schema is not enough: the schema travels to the adapter instead —
 * and, as the search_path, to every connection, so that raw SQL meets the
 * same tables Prisma's own queries name.
 *
 *   postgresql://user:pw@host:5432/db?schema=sadara_test_ab12
 *     → { connectionString: 'postgresql://user:pw@host:5432/db',
 *         schema: 'sadara_test_ab12', options: '-c search_path=sadara_test_ab12' }
 */
export interface DatabaseConnection {
  connectionString: string;
  schema: string | undefined;
  /** pg's startup options: the schema as the search_path, when there is one. */
  options: string | undefined;
}

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export function databaseConnectionOf(url: string): DatabaseConnection {
  const parsed = new URL(url);
  const schema = parsed.searchParams.get('schema') ?? undefined;
  if (schema !== undefined && !SCHEMA_NAME.test(schema)) {
    throw new Error(
      'The database URL names a schema that is not a plain lowercase PostgreSQL identifier',
    );
  }
  parsed.searchParams.delete('schema');
  return {
    connectionString: parsed.toString(),
    schema,
    // A plain lowercase identifier (checked above) needs no quoting.
    options: schema ? `-c search_path=${schema}` : undefined,
  };
}
