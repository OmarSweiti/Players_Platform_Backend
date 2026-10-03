import type { TestProject } from 'vitest/node';
import { createIsolatedSchema } from './db';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    databaseSchema: string;
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
  project.provide('databaseSchema', run.schema);
  return async () => {
    if (process.env.KEEP_TEST_SCHEMA !== '1') await run.drop();
  };
}
