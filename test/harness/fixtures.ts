import { randomBytes, randomUUID } from 'node:crypto';
import type {
  Player,
  PrismaClient,
  Tenant,
  User,
  UserRole,
} from '@prisma/client';
import { afterAll, inject } from 'vitest';
import {
  type AuthorizedTenantContext,
  mintTenantContext,
} from '../../src/common/tenancy/tenant-context';
import {
  TenantTransactions,
  type TenantTx,
} from '../../src/common/tenancy/tenant-transaction';
import { prismaFor } from './db';

// Fixtures write straight to the run's schema — never through the seed — and
// every value is synthetic: names are invented, addresses use the reserved
// `.test` domain. Tests always create the tenants they need, usually two.
// Row-level security (0.4.5) shows the runtime role nothing without a tenant,
// so every fixture writes as the tenant it belongs to, through asTenant.

let runClient: ReturnType<typeof prismaFor> | undefined;

/** The Prisma client of this run's schema, opened on first use and closed after the file. */
export function runPrisma(): PrismaClient {
  runClient ??= prismaFor(inject('databaseUrl'));
  return runClient.prisma;
}

let migrationClient: ReturnType<typeof prismaFor> | undefined;

/**
 * The migrator's client for this run's schema: only for a test that changes the
 * schema itself (a probe table), never for data — the runtime role cannot.
 */
export function migrationPrisma(): PrismaClient {
  migrationClient ??= prismaFor(inject('migrationDatabaseUrl'));
  return migrationClient.prisma;
}

afterAll(async () => {
  await Promise.all([runClient?.close(), migrationClient?.close()]);
  runClient = undefined;
  migrationClient = undefined;
});

const suffix = () => randomBytes(4).toString('hex');

/**
 * A tenant context for test code acting as `tenantId`. The harness stands in
 * for the minters (the session guard, the job loader): tests are outside src/,
 * where the lint rule allows mintTenantContext. Throws on a malformed id.
 */
export function testContext(
  tenantId: string,
  job = 'test-fixture',
): AuthorizedTenantContext {
  return mintTenantContext({
    tenantId,
    actor: { kind: 'SYSTEM', job },
    requestId: randomUUID(),
    locale: 'en',
  });
}

/**
 * Runs `work` as `tenantId`, the way a use case does (0.4.3): one tenant
 * transaction, through the real TenantTransactions, so row-level security
 * (0.4.5) shows and accepts that tenant's rows only.
 */
export function asTenant<T>(
  tenantId: string,
  work: (tx: TenantTx) => Promise<T>,
  prisma: PrismaClient = runPrisma(),
): Promise<T> {
  return new TenantTransactions(prisma).withTenantTransaction(
    testContext(tenantId),
    work,
  );
}

export function createTenant(
  opts: { slug?: string; prisma?: PrismaClient } = {},
): Promise<Tenant> {
  // A tenant sees and writes its own row only, so its id comes first.
  const id = randomUUID();
  const slug = opts.slug ?? `tenant-${suffix()}`;
  return asTenant(
    id,
    (tx) =>
      tx.tenant.create({ data: { id, name: `Test agency ${slug}`, slug } }),
    opts.prisma,
  );
}

export function createPlayer(
  tenant: Tenant,
  prisma: PrismaClient = runPrisma(),
): Promise<Player> {
  return asTenant(
    tenant.id,
    (tx) =>
      tx.player.create({
        data: { tenantId: tenant.id, fullName: `Test Player ${suffix()}` },
      }),
    prisma,
  );
}

export function createMember(
  tenant: Tenant,
  role: UserRole,
  prisma: PrismaClient = runPrisma(),
): Promise<User> {
  const handle = `${role.toLowerCase()}-${suffix()}`;
  return asTenant(
    tenant.id,
    (tx) =>
      tx.user.create({
        data: {
          tenantId: tenant.id,
          email: `${handle}@${tenant.slug}.test`,
          role,
        },
      }),
    prisma,
  );
}
