import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Client, Pool } from 'pg';
import { databaseConnectionOf } from '../../src/infrastructure/prisma/database-url';

const run = promisify(execFile);
const BACKEND_ROOT = resolve(__dirname, '../..');

function urlFrom(name: string, role: string, password: string): string {
  const url = process.env[name];
  if (!url) {
    throw new Error(
      `${name} is not set. Point it at the test database of the local stack, as ${role} ` +
        '(`just up` in the umbrella creates both), for example ' +
        `postgresql://${role}:<${password}>@127.0.0.1:5432/sadara_test — ` +
        "the backend's `just test-int` and `just test-e2e` derive it from the umbrella's infra/.env.",
    );
  }
  return url;
}

/** The database every test run makes its own schema in, as the runtime role: the local stack's `sadara_test`. */
export function testDatabaseUrl(): string {
  return urlFrom('DATABASE_URL_TEST', 'sadara_app', 'SADARA_APP_PASSWORD');
}

/** The same database as the migrator, which creates, migrates and drops each run's schema (0.4.2). */
export function testMigrationDatabaseUrl(): string {
  return urlFrom(
    'MIGRATION_DATABASE_URL_TEST',
    'sadara_migrator',
    'SADARA_MIGRATOR_PASSWORD',
  );
}

/**
 * The same database as the registry role (0.7.6), which reads the tenant
 * directory's ids: what the worker finds its tenants with.
 */
export function testRegistryDatabaseUrl(): string {
  return urlFrom(
    'REGISTRY_DATABASE_URL_TEST',
    'sadara_registry',
    'SADARA_REGISTRY_PASSWORD',
  );
}

export interface IsolatedSchema {
  /** `sadara_test_<12 hex>`: unique per run, so two runs never share data. */
  schema: string;
  /** The runtime role's URL with `?schema=…`: what the application and the fixtures connect as. */
  url: string;
  /** The migrator's URL with `?schema=…`: only for a test that changes the schema itself. */
  migrationUrl: string;
  drop(): Promise<void>;
}

async function onDatabase<T>(
  url: string,
  work: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({
    connectionString: databaseConnectionOf(url).connectionString,
  });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** `url` with `?schema=…` set. */
export function inSchema(url: string, schema: string): string {
  const scoped = new URL(url);
  scoped.searchParams.set('schema', schema);
  return scoped.toString();
}

/**
 * A fresh schema with every migration applied — the run's private database.
 * The migrator creates, migrates and drops it, so it and everything in it
 * belong to sadara_owner; the runtime role gets data rights only, through the
 * owner's default privileges (scripts/database-roles.sql).
 */
export async function createIsolatedSchema(
  base: string = testDatabaseUrl(),
  migrationBase: string = testMigrationDatabaseUrl(),
): Promise<IsolatedSchema> {
  const schema = `sadara_test_${randomBytes(6).toString('hex')}`;
  await onDatabase(migrationBase, (client) =>
    client.query(`CREATE SCHEMA "${schema}"`),
  );
  const drop = () =>
    onDatabase(migrationBase, (client) =>
      client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`),
    ).then(() => undefined);
  const migrationUrl = inSchema(migrationBase, schema);
  try {
    // prisma.config.ts reads MIGRATION_DATABASE_URL; the app's URL is not passed on.
    const { DATABASE_URL: _app, ...env } = process.env;
    await run('npx', ['--no-install', 'prisma', 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: {
        ...env,
        MIGRATION_DATABASE_URL: migrationUrl,
        // Prisma's advisory lock is one per database, and keeps two
        // migrations of the same schema apart. This schema is its own, with
        // its own migration history, and no migration touches anything
        // database-wide: the lock would only make test files that migrate
        // their schemas at once wait on each other, past Prisma's ten
        // seconds, into a P1002.
        PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK: '1',
      },
    });
  } catch (error) {
    await drop();
    throw error;
  }
  return { schema, url: inSchema(base, schema), migrationUrl, drop };
}

/**
 * A Prisma client bound to one run's schema, for fixtures and assertions outside
 * the app. `max: 1` makes every statement reuse one connection, for a test that
 * must see what a pooled connection carries from one piece of work to the next.
 */
export function prismaFor(
  url: string,
  { max = 2 }: { max?: number } = {},
): {
  prisma: PrismaClient;
  close(): Promise<void>;
} {
  const { connectionString, schema, options } = databaseConnectionOf(url);
  const pool = new Pool({ connectionString, options, max });
  const prisma = new PrismaClient({
    adapter: new PrismaPg(pool, schema ? { schema } : undefined),
  });
  return {
    prisma,
    close: async () => {
      await prisma.$disconnect();
      await pool.end();
    },
  };
}
