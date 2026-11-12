import type { TestProject } from 'vitest/node';
import { createIsolatedSchema, inSchema, testRegistryDatabaseUrl } from './db';
import { type ObjectStoreSettings, objectStoreForTests } from './object-store';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    migrationDatabaseUrl: string;
    databaseSchema: string;
    /** The registry role's URL for the run's schema (0.7.6). */
    registryDatabaseUrl: string;
    /** The object store's test bucket and keys (0.8.1), or null when none is configured. */
    objectStore: ObjectStoreSettings | null;
    /** ClamAV's daemon (0.8.4), or null when none is configured. */
    scanner: { host: string; port: number } | null;
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
  // Only the storage port's tests reach the object store (0.8.1); they refuse
  // to run without it. Its test bucket exists, versioned, before any does.
  project.provide('objectStore', await objectStoreForTests());
  // Only the scan's tests reach ClamAV (0.8.4); they refuse to run without it.
  const { CLAMAV_HOST_TEST: host, CLAMAV_PORT_TEST: port } = process.env;
  project.provide(
    'scanner',
    host ? { host, port: Number(port ?? 3310) } : null,
  );
  return async () => {
    if (process.env.KEEP_TEST_SCHEMA !== '1') await run.drop();
  };
}
