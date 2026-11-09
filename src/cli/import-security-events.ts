import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { NestFactory } from '@nestjs/core';
import { z } from 'zod';
import { DomainError } from '../common/errors/domain-error';
import { parseEventImportEnv } from '../config/env.schema';
import { ImportProviderSecurityEventsUseCase } from '../modules/identity/application/use-cases/import-provider-security-events.usecase';
import { SecurityEventImportModule } from '../modules/identity/security-event-import.module';

// The security-event import (0.7.3; DB-61): the identity provider's own login
// and admin events into security_events, each kept once by its id at the
// provider. A platform operation an operator runs, never an endpoint; 0.7.6's
// worker will run it on a schedule.
//
//   npm run build
//   npm run security-events:import -- [--hours 24] [--limit 1000]
//
// It reads the API's settings and the event reader's (OIDC_EVENTS_*), from the
// environment and, as the API does, .env. It prints what it did as JSON,
// counts only, never an event's values; exit 0 when done, 1 when the import
// failed (run it again: what was imported stays, and nothing is imported
// twice), 2 when the command or its settings are wrong. A report that is not
// complete read only the newest events of the window, up to the limit: run it
// again with a shorter window, or a larger limit.

const USAGE = `Usage: npm run security-events:import -- [--hours <1-720>] [--limit <1-10000>]
Imports the identity provider's login and admin events of the last --hours (24 when not given),
at most --limit of each kind (1000 when not given), newest first.`;

const Arguments = z.strictObject({
  hours: z.coerce.number().int().min(1).max(720).default(24),
  limit: z.coerce.number().int().min(1).max(10_000).default(1000),
});

type Write = (text: string) => void;

/**
 * Runs the command: `argv` its arguments, `env` its environment, `now` the
 * instant its window ends. Returns the exit code. Exported so that tests run
 * it as the operator does, in-process.
 */
export async function run(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  out: Write = (text) => process.stdout.write(text),
  err: Write = (text) => process.stderr.write(text),
  now: () => Date = () => new Date(),
): Promise<number> {
  let options: Record<string, unknown>;
  try {
    ({ values: options } = parseArgs({
      args: [...argv],
      options: {
        hours: { type: 'string' },
        limit: { type: 'string' },
        help: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    err(`import-security-events: an unknown or malformed option.\n${USAGE}\n`);
    return 2;
  }
  if (options.help) {
    out(`${USAGE}\n`);
    return 0;
  }
  const { help: _help, ...given } = options;
  const parsed = Arguments.safeParse(given);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `--${String(issue.path[0] ?? '?')}: ${issue.message}`,
    );
    err(`import-security-events: ${problems.join('; ')}\n${USAGE}\n`);
    return 2;
  }
  let settings;
  try {
    settings = parseEventImportEnv(env);
  } catch (error) {
    err(`import-security-events: ${(error as Error).message}\n`);
    return 2;
  }

  const since = new Date(now().getTime() - parsed.data.hours * 3_600_000);
  const app = await NestFactory.createApplicationContext(
    SecurityEventImportModule.forSettings(settings),
    { logger: false },
  );
  try {
    const report = await app
      .get(ImportProviderSecurityEventsUseCase)
      .execute({ since, limit: parsed.data.limit });
    out(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.complete) {
      err(
        'import-security-events: the window held more events than the limit; the newest were imported. Run it again with a shorter window or a larger limit.\n',
      );
    }
    return 0;
  } catch (error) {
    err(
      `import-security-events: ${describe(error)}. What was imported stays; running it again imports nothing twice.\n`,
    );
    return 1;
  } finally {
    await app.close();
  }
}

/** A failure, in words that never repeat a value. */
function describe(error: unknown): string {
  if (error instanceof DomainError) return `${error.code}: ${error.message}`;
  return `INTERNAL_ERROR: ${error instanceof Error ? error.name : 'unknown'}`;
}

if (require.main === module) {
  // As the API does: .env fills what the environment does not set.
  if (existsSync('.env')) process.loadEnvFile('.env');
  void run(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
}
