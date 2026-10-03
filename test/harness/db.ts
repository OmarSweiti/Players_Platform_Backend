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

/** The database every test run makes its own schema in: the local stack's `sadara_test`. */
export function testDatabaseUrl(): string {
  const url = process.env.DATABASE_URL_TEST;
  if (!url) {
    throw new Error(
      'DATABASE_URL_TEST is not set. Point it at the test database of the local stack ' +
        '(`just up` in the umbrella creates it), for example ' +
        'postgresql://postgres:<POSTGRES_PASSWORD>@127.0.0.1:5432/sadara_test — ' +
        "the backend's `just test-int` and `just test-e2e` derive it from the umbrella's infra/.env.",
    );
  }
  return url;
}

export interface IsolatedSchema {
  /** `sadara_test_<12 hex>`: unique per run, so two runs never share data. */
  schema: string;
  /** The test database URL with `?schema=…`, which the app and Prisma's migrations both honour. */
  url: string;
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

/** A fresh schema with every migration applied — the run's private database. */
export async function createIsolatedSchema(
  base: string = testDatabaseUrl(),
): Promise<IsolatedSchema> {
  const schema = `sadara_test_${randomBytes(6).toString('hex')}`;
  await onDatabase(base, (client) => client.query(`CREATE SCHEMA "${schema}"`));
  const url = new URL(base);
  url.searchParams.set('schema', schema);
  const drop = () =>
    onDatabase(base, (client) =>
      client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`),
    ).then(() => undefined);
  try {
    await run('npx', ['--no-install', 'prisma', 'migrate', 'deploy'], {
      cwd: BACKEND_ROOT,
      env: { ...process.env, DATABASE_URL: url.toString() },
    });
  } catch (error) {
    await drop();
    throw error;
  }
  return { schema, url: url.toString(), drop };
}

/** A Prisma client bound to one run's schema, for fixtures and assertions outside the app. */
export function prismaFor(url: string): {
  prisma: PrismaClient;
  close(): Promise<void>;
} {
  const { connectionString, schema } = databaseConnectionOf(url);
  const pool = new Pool({ connectionString, max: 2 });
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
