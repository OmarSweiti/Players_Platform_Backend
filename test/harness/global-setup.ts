import type { TestProject } from 'vitest/node';
import { createIsolatedSchema, inSchema, testRegistryDatabaseUrl } from './db';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    migrationDatabaseUrl: string;
    databaseSchema: string;
    /** The registry role's URL for the run's schema (0.7.6). */
    registryDatabaseUrl: string;
  }
}

/**
 * Runs once per integration or e2e run: a fresh, fully migrated schema that no
 * other run can see, handed to the test files through `inject`, and dropped
 * afterwards (set KEEP_TEST_SCHEMA=1 to keep it for a post-mortem).
 */
export default async function setup(
  project: TestProject,
): Promise<() => Promise<void>> {
  const run = await createIsolatedSchema();
  project.provide('databaseUrl', run.url);
  project.provide('migrationDatabaseUrl', run.migrationUrl);
  project.provide('databaseSchema', run.schema);
  // Only the worker's tests log in as the registry role (0.7.6); they refuse to
  // run without it, and every other suite runs as before.
  project.provide(
    'registryDatabaseUrl',
    process.env.REGISTRY_DATABASE_URL_TEST
      ? inSchema(testRegistryDatabaseUrl(), run.schema)
      : '',
  );
  return async () => {
    if (process.env.KEEP_TEST_SCHEMA !== '1') await run.drop();
  };
}
