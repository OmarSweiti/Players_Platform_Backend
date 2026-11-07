import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { type DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DomainError } from '../common/errors/domain-error';
import { mintTenantContext } from '../common/tenancy/tenant-context';
import { TenantTransactions } from '../common/tenancy/tenant-transaction';
import { type Env, parseEnv } from '../config/env.schema';
import { problemCodeOfPrismaError } from '../infrastructure/prisma/prisma-errors';
import { PrismaModule } from '../infrastructure/prisma/prisma.module';
import { seedDevelopmentData } from './seed-development-data';

// The synthetic seed (0.5.11): the development data, into a development or
// test database, idempotently.
//
//   just seed                  (npm run seed)
//
// It reads the API's settings, from the environment and, as the API does,
// .env: the database as the runtime role, and OIDC_ISSUER, whose development
// realm holds the members' accounts. It prints what it made and changed as
// JSON, never an address; exit 0 when done, 1 when the seed failed (run it
// again once fixed), 2 when it may not run here.

const USAGE = 'Usage: just seed   (it takes no arguments)';

/** Where synthetic data may go: never a staging or production database. */
const SEEDABLE = new Set(['development', 'test']);

type Write = (text: string) => void;

/** The seed's composition: the settings and the database, nothing of the API's routes, sessions or limits. */
@Module({})
class SeedModule {
  static forSettings(settings: Env): DynamicModule {
    return {
      module: SeedModule,
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          validate: () => settings,
        }),
        PrismaModule,
      ],
    };
  }
}

/**
 * Runs the seed: `argv` its arguments, `env` its environment. Returns the exit
 * code. Exported so that a test runs it as a developer does, in-process.
 */
export async function run(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  out: Write = (text) => process.stdout.write(text),
  err: Write = (text) => process.stderr.write(text),
): Promise<number> {
  if (argv.length > 0) {
    err(`seed: refused — ${USAGE}\n`);
    return 2;
  }
  if (!SEEDABLE.has(env.NODE_ENV ?? '')) {
    err(
      'seed: refused — synthetic data goes only into a development or test database (NODE_ENV development or test).\n',
    );
    return 2;
  }
  let settings: Env;
  try {
    settings = parseEnv(env);
  } catch (error) {
    err(`seed: ${(error as Error).message}\n`);
    return 2;
  }

  // The seed mints the contexts it writes each tenant in (0.4.3): a
  // development operation, refused anywhere else, above.
  const contextFor = (tenantId: string) =>
    mintTenantContext({
      tenantId,
      actor: { kind: 'SYSTEM', job: 'seed' },
      requestId: randomUUID(),
      locale: 'en',
    });

  const app = await NestFactory.createApplicationContext(
    SeedModule.forSettings(settings),
    { logger: false },
  );
  try {
    const report = await seedDevelopmentData(
      app.get(TenantTransactions),
      contextFor,
      settings.OIDC_ISSUER,
    );
    out(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (error) {
    err(
      `seed: ${describe(error)}. What it had already written stays; running it again, once fixed, finishes the rest.\n`,
    );
    return 1;
  } finally {
    await app.close();
  }
}

/** A failure, in words that never repeat a value. */
function describe(error: unknown): string {
  if (error instanceof DomainError) return `${error.code}: ${error.message}`;
  const code = problemCodeOfPrismaError(error);
  if (code) return `${code}: the database refused a seeded row`;
  return `INTERNAL_ERROR: ${error instanceof Error ? error.name : 'unknown'}`;
}

if (require.main === module) {
  // As the API does: .env fills what the environment does not set.
  if (existsSync('.env')) process.loadEnvFile('.env');
  void run(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
}
