import { randomBytes } from 'node:crypto';
import type { PrismaClient, Tenant, User, UserRole } from '@prisma/client';
import { afterAll, inject } from 'vitest';
import { prismaFor } from './db';

// Fixtures write straight to the run's schema — never through the seed — and
// every value is synthetic: names are invented, addresses use the reserved
// `.test` domain. Tests always create the tenants they need, usually two.

let runClient: ReturnType<typeof prismaFor> | undefined;

/** The Prisma client of this run's schema, opened on first use and closed after the file. */
export function runPrisma(): PrismaClient {
  runClient ??= prismaFor(inject('databaseUrl'));
  return runClient.prisma;
}

afterAll(async () => {
  await runClient?.close();
  runClient = undefined;
});

const suffix = () => randomBytes(4).toString('hex');

export function createTenant(
  opts: { slug?: string; prisma?: PrismaClient } = {},
): Promise<Tenant> {
  const slug = opts.slug ?? `tenant-${suffix()}`;
  return (opts.prisma ?? runPrisma()).tenant.create({
    data: { name: `Test agency ${slug}`, slug },
  });
}

export function createMember(
  tenant: Tenant,
  role: UserRole,
  prisma: PrismaClient = runPrisma(),
): Promise<User> {
  const handle = `${role.toLowerCase()}-${suffix()}`;
  return prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: `${handle}@${tenant.slug}.test`,
      // The local credential columns retire with 0.1.6; nothing can sign in with this value.
      passwordHash: 'not-a-password-hash',
      role,
    },
  });
}
