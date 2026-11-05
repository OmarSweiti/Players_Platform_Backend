import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { NestFactory } from '@nestjs/core';
import { z } from 'zod';
import { DomainError } from '../common/errors/domain-error';
import { mintTenantContext } from '../common/tenancy/tenant-context';
import {
  DNS_LABEL,
  HOST_NAME,
  parseProvisioningEnv,
} from '../config/env.schema';
import { problemCodeOfPrismaError } from '../infrastructure/prisma/prisma-errors';
import {
  type ProvisionTenant,
  ProvisionTenantUseCase,
} from '../modules/platform/application/use-cases/provision-tenant.usecase';
import { ProvisioningModule } from '../modules/platform/provisioning.module';

// The tenant provisioning command (0.5.9; BR-OBJ-08): a platform operation an
// operator runs, never an endpoint.
//
//   npm run build
//   npm run tenant:provision -- --slug sadara --name "Sadara Sports Agency" \
//     --domain sadara.example --owner-email owner@sadara.test [--locale ar]
//
// It reads the API's settings and the provisioning account's
// (OIDC_PROVISIONER_*), from the environment and, as the API does, .env. It
// prints what it did as JSON, never the owner's address; exit 0 when done, 1
// when the operation failed (run it again: it is idempotent per slug), 2 when
// the command or its settings are wrong.

const USAGE = `Usage: npm run tenant:provision -- --slug <label> --name <name> --owner-email <address>
       [--domain <host>] [--locale ar|en] [--resend-setup-email]
It never takes a password: the owner chooses one at the identity provider, from the setup email.`;

const Arguments = z.strictObject({
  slug: z.string().trim().toLowerCase().regex(DNS_LABEL, 'a DNS label'),
  name: z.string().trim().min(1).max(255),
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(HOST_NAME, 'a host name')
    .optional(),
  'owner-email': z.email().max(255),
  locale: z.enum(['ar', 'en']).default('ar'),
  'resend-setup-email': z.boolean().default(false),
});

/** Anything that names a secret: refused before any argument is read. */
const SECRET_OPTION = /^-{1,2}[^=]*(pass|pwd|secret|credential)/i;

type Write = (text: string) => void;

/**
 * Runs the command: `argv` its arguments, `env` its environment. Returns the
 * exit code. Exported so that tests run it as the operator does, in-process.
 */
export async function run(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  out: Write = (text) => process.stdout.write(text),
  err: Write = (text) => process.stderr.write(text),
): Promise<number> {
  if (argv.some((arg) => SECRET_OPTION.test(arg))) {
    err(
      'provision-tenant: refused — it never takes a password: the owner chooses one at the identity provider, from the setup email.\n',
    );
    return 2;
  }
  let options: Record<string, unknown>;
  try {
    ({ values: options } = parseArgs({
      args: [...argv],
      options: {
        slug: { type: 'string' },
        name: { type: 'string' },
        domain: { type: 'string' },
        'owner-email': { type: 'string' },
        locale: { type: 'string' },
        'resend-setup-email': { type: 'boolean' },
        help: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    err(`provision-tenant: an unknown or malformed option.\n${USAGE}\n`);
    return 2;
  }
  if (options.help) {
    out(`${USAGE}\n`);
    return 0;
  }
  const parsed = Arguments.safeParse(options);
  if (!parsed.success) {
    // The option, and what it should be: never the value given.
    const problems = parsed.error.issues.map(
      (issue) => `--${String(issue.path[0] ?? '?')}: ${issue.message}`,
    );
    err(`provision-tenant: ${problems.join('; ')}\n${USAGE}\n`);
    return 2;
  }
  let settings;
  try {
    settings = parseProvisioningEnv(env);
  } catch (error) {
    err(`provision-tenant: ${(error as Error).message}\n`);
    return 2;
  }

  const request: ProvisionTenant = {
    slug: parsed.data.slug,
    name: parsed.data.name,
    domain: parsed.data.domain,
    ownerEmail: parsed.data['owner-email'],
    locale: parsed.data.locale,
    resendSetupEmail: parsed.data['resend-setup-email'],
  };
  // An audited platform operation mints the context it works in (0.4.3).
  const contextFor = (tenantId: string) =>
    mintTenantContext({
      tenantId,
      actor: { kind: 'SYSTEM', job: 'tenant:provision' },
      requestId: randomUUID(),
      locale: request.locale,
    });

  const app = await NestFactory.createApplicationContext(
    ProvisioningModule.forSettings(settings),
    { logger: false },
  );
  try {
    const report = await app
      .get(ProvisionTenantUseCase)
      .execute(request, contextFor);
    out(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (error) {
    err(
      `provision-tenant: ${describe(error)}. It stopped there: what it had already made stays, and running it again, once fixed, finishes the rest.\n`,
    );
    return 1;
  } finally {
    await app.close();
  }
}

/** A failure, in words that never repeat a value. */
function describe(error: unknown): string {
  if (error instanceof DomainError) return `${error.code}: ${error.message}`;
  if (problemCodeOfPrismaError(error) === 'CONFLICT') {
    return 'CONFLICT: another tenant already has this slug or domain';
  }
  return `INTERNAL_ERROR: ${error instanceof Error ? error.name : 'unknown'}`;
}

if (require.main === module) {
  // As the API does: .env fills what the environment does not set.
  if (existsSync('.env')) process.loadEnvFile('.env');
  void run(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
}
