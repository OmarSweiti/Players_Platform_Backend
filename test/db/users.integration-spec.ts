import { randomUUID } from 'node:crypto';
import type { Tenant, User } from '@prisma/client';
import { Client, type DatabaseError } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  ConflictError,
  NotFoundError,
} from '../../src/common/errors/domain-error';
import { mintTenantContext } from '../../src/common/tenancy/tenant-context';
import { TenantTransactions } from '../../src/common/tenancy/tenant-transaction';
import { databaseConnectionOf } from '../../src/infrastructure/prisma/database-url';
import { ReactivateMembership } from '../../src/modules/users/application/use-cases/reactivate-membership.usecase';
import { normalizeEmail } from '../../src/modules/users/domain/email';
import {
  asTenant,
  createMember,
  createTenant,
  runPrisma,
} from '../harness/fixtures';

// Normalised emails and lifetime memberships (0.4.9; DB-10), as the runtime
// role, on two tenants. Every address is synthetic, on the .test domain.

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const KEY = 'users_tenant_id_normalized_email_key';

async function connect(url: string): Promise<Client> {
  const { connectionString, options } = databaseConnectionOf(url);
  const client = new Client({ connectionString, options });
  await client.connect();
  return client;
}

describe('member emails and lifetime memberships', () => {
  let app: Client;
  let a: Tenant;
  let b: Tenant;

  /** A raw INSERT of a member of `tenant`, as that tenant: what it did. */
  async function insertMember(
    tenant: Tenant,
    email: string,
    normalized = normalizeEmail(email),
  ): Promise<'inserted' | { code?: string; constraint?: string }> {
    await app.query('BEGIN');
    try {
      await app.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenant.id,
      ]);
      await app.query(
        `INSERT INTO users (id, tenant_id, email, normalized_email, role, updated_at)
         VALUES ($1, $2, $3, $4, 'COACH', now())`,
        [randomUUID(), tenant.id, email, normalized],
      );
      await app.query('COMMIT');
      return 'inserted';
    } catch (error) {
      await app.query('ROLLBACK');
      const { code, constraint } = error as DatabaseError;
      return { code, constraint };
    }
  }

  const archive = (member: User) =>
    asTenant(member.tenantId, (tx) =>
      tx.user.update({
        where: { id_tenantId: { id: member.id, tenantId: member.tenantId } },
        data: { deletedAt: new Date(), isActive: false },
      }),
    );

  beforeAll(async () => {
    app = await connect(inject('databaseUrl'));
    [a, b] = [await createTenant(), await createTenant()];
  });

  afterAll(async () => {
    await app?.end();
  });

  it('emails_are_unique_regardless_of_case_and_spacing', async () => {
    const address = `coach.one-${randomUUID().slice(0, 8)}@agency.test`;
    expect(await insertMember(a, address)).toBe('inserted');
    // The same address, cased or spaced another way, in the same tenant.
    for (const variant of [
      address.toUpperCase(),
      ` ${address}\t`,
      `\r\n${address.replace('coach', 'Coach')} `,
    ]) {
      expect(normalizeEmail(variant)).toBe(address);
      expect([variant, await insertMember(a, variant)]).toEqual([
        variant,
        { code: UNIQUE_VIOLATION, constraint: KEY },
      ]);
    }
    // Unique within a tenant only: another agency may have the same address.
    expect(await insertMember(b, address.toUpperCase())).toBe('inserted');

    // The database holds the normal form to the application's rule, so a row
    // cannot be written with one that disagrees with its address.
    expect(
      await insertMember(
        a,
        `other-${randomUUID().slice(0, 8)}@agency.test`,
        'someone-else@agency.test',
      ),
    ).toEqual({
      code: CHECK_VIOLATION,
      constraint: 'users_normalized_email_check',
    });
    for (const sample of [
      'Mixed.Case@Agency.TEST',
      '  spaced@agency.test\n',
      'ＦＵＬＬＷＩＤＴＨ@agency.test', // NFKC folds the full-width letters
      'Élodie@agency.test',
    ]) {
      const { rows } = await app.query<{ normalized: string }>(
        `SELECT lower(btrim(normalize($1::text, NFKC), E' \\t\\r\\n')) AS normalized`,
        [sample],
      );
      expect([sample, normalizeEmail(sample)]).toEqual([
        sample,
        rows[0].normalized,
      ]);
    }
  });

  it('an_archived_members_email_stays_reserved', async () => {
    const member = await createMember(a, 'COACH');
    await archive(member);
    // Archived, the membership still holds its address: a new member with it,
    // however written, is refused.
    expect(await insertMember(a, member.email)).toEqual({
      code: UNIQUE_VIOLATION,
      constraint: KEY,
    });
    expect(await insertMember(a, ` ${member.email.toUpperCase()} `)).toEqual({
      code: UNIQUE_VIOLATION,
      constraint: KEY,
    });
  });

  it('reactivation_restores_the_same_membership', async () => {
    const member = await createMember(a, 'COACH');
    const memberOfB = await createMember(b, 'COACH');
    await Promise.all([archive(member), archive(memberOfB)]);
    const reactivate = new ReactivateMembership(
      new TenantTransactions(runPrisma()),
    );
    const admin = await createMember(a, 'ADMIN');
    const asAdminOfA = mintTenantContext({
      tenantId: a.id,
      actor: {
        kind: 'USER',
        userId: admin.id,
        sessionId: randomUUID(),
        role: admin.role,
      },
      requestId: randomUUID(),
      locale: 'en',
    });

    // The same membership comes back: its id, its address, active again.
    await expect(reactivate.execute(asAdminOfA, member.id)).resolves.toEqual({
      id: member.id,
    });
    const restored = await asTenant(a.id, (tx) =>
      tx.user.findMany({
        where: { normalizedEmail: member.normalizedEmail },
        select: { id: true, deletedAt: true, isActive: true },
      }),
    );
    expect(restored).toEqual([
      { id: member.id, deletedAt: null, isActive: true },
    ]);

    // With its audit entry, in the same transaction, naming who did it.
    const audit = await asTenant(a.id, (tx) =>
      tx.auditLog.findMany({
        where: { entityId: member.id },
        select: {
          action: true,
          entityType: true,
          userId: true,
          newValues: true,
        },
      }),
    );
    expect(audit).toEqual([
      {
        action: 'membership.reactivated',
        entityType: 'User',
        userId: admin.id,
        newValues: { archivedAt: null },
      },
    ]);

    // An active membership is not reactivated, and another tenant's member is
    // not found from this one.
    await expect(
      reactivate.execute(asAdminOfA, member.id),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      reactivate.execute(asAdminOfA, memberOfB.id),
    ).rejects.toBeInstanceOf(NotFoundError);
    const stillArchived = await asTenant(b.id, (tx) =>
      tx.user.findUniqueOrThrow({
        where: { id: memberOfB.id },
        select: { deletedAt: true },
      }),
    );
    expect(stillArchived.deletedAt).not.toBeNull();
  });
});
