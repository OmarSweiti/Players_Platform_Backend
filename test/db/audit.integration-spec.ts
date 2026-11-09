import { randomBytes, randomUUID } from 'node:crypto';
import type { PrismaClient, Tenant, User } from '@prisma/client';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ValidationFailedError } from '../../src/common/errors/domain-error';
import type { AuthorizedTenantContext } from '../../src/common/tenancy/tenant-context';
import { TenantTransactions } from '../../src/common/tenancy/tenant-transaction';
import { fixedClock } from '../../src/common/time/clock';
import { databaseConnectionOf } from '../../src/infrastructure/prisma/database-url';
import {
  AuditEventRefused,
  AuditService,
  USER_AGENT_MAX,
} from '../../src/infrastructure/audit/audit.service';
import {
  AUDITED_ACTIONS,
  type AuditAction,
  type AuditEvent,
} from '../../src/infrastructure/audit/audited-actions';
import type { IdentityProviderPort } from '../../src/modules/identity/application/ports/identity-provider.port';
import { InviteMemberUseCase } from '../../src/modules/users/application/use-cases/invite-member.usecase';
import { ManageInvitationsUseCase } from '../../src/modules/users/application/use-cases/manage-invitations.usecase';
import { ReactivateMembership } from '../../src/modules/users/application/use-cases/reactivate-membership.usecase';
import { InvitationRepository } from '../../src/modules/users/infrastructure/repositories/invitation.repository';
import {
  createIsolatedSchema,
  type IsolatedSchema,
  prismaFor,
} from '../harness/db';
import {
  asTenant,
  createMember,
  createTenant,
  memberContext,
  runPrisma,
} from '../harness/fixtures';

// Audit inside the business transaction (0.7.2; SR-AUD-002–004, SR-ACL-006).
// The users module's use cases record through the audit service, on their own
// transaction: a change that rolls back leaves no entry, and an entry that
// cannot be written aborts the change. Payloads are allowlisted structural
// deltas; personal and confidential values are references. Two tenants, real
// PostgreSQL 18, as the runtime role.

const suffix = () => randomBytes(4).toString('hex');
const DAY_MS = 24 * 3_600_000;

/** The identity provider, as the invitation needs it: an account found or made. */
const provider = {
  findAccount: () => Promise.resolve(null),
  createAccount: () => Promise.resolve({ subject: randomUUID() }),
} as unknown as IdentityProviderPort;

/** Every audit row about `entityId`, as the tenant reads it. */
function auditOf(tenant: Tenant, entityId: string, prisma?: PrismaClient) {
  return asTenant(
    tenant.id,
    (tx) =>
      tx.auditLog.findMany({
        where: { entityId },
        orderBy: { createdAt: 'asc' },
      }),
    prisma,
  );
}

/** A member archived a day ago: what a reactivation brings back. */
function archivedMember(tenant: Tenant, prisma?: PrismaClient) {
  return createMember(tenant, 'COACH', prisma).then((member) =>
    asTenant(
      tenant.id,
      (tx) =>
        tx.user.update({
          where: { id: member.id },
          data: { deletedAt: new Date(Date.now() - DAY_MS), isActive: false },
        }),
      prisma,
    ),
  );
}

describe('audit inside the business transaction', () => {
  let a: Tenant;
  let b: Tenant;
  let ownerA: User;
  let ownerB: User;
  const audit = new AuditService();
  const transactions = () => new TenantTransactions(runPrisma());
  const invitations = () =>
    new InviteMemberUseCase(
      transactions(),
      new InvitationRepository(),
      provider,
      fixedClock(new Date()),
      audit,
    );

  beforeAll(async () => {
    [a, b] = [await createTenant(), await createTenant()];
    [ownerA, ownerB] = [
      await createMember(a, 'OWNER'),
      await createMember(b, 'OWNER'),
    ];
  });

  it('a_rolled_back_change_leaves_no_audit_row', async () => {
    for (const [tenant, owner] of [
      [a, ownerA],
      [b, ownerB],
    ] as const) {
      const member = await archivedMember(tenant);
      // The reactivation writes its entry, and then the transaction fails:
      // neither the change nor the entry is kept.
      class FailingAfterAudit extends AuditService {
        override async record<A extends AuditAction>(
          ...args: Parameters<AuditService['record']>
        ): Promise<void> {
          await super.record(...(args as [never, never, AuditEvent<A>]));
          throw new ValidationFailedError('a later step of the change fails');
        }
      }
      await expect(
        new ReactivateMembership(
          transactions(),
          new FailingAfterAudit(),
        ).execute(memberContext(owner), member.id),
      ).rejects.toBeInstanceOf(ValidationFailedError);
      expect(
        await asTenant(tenant.id, (tx) =>
          tx.user.findUniqueOrThrow({
            where: { id: member.id },
            select: { deletedAt: true },
          }),
        ),
      ).toEqual({ deletedAt: member.deletedAt });
      expect(await auditOf(tenant, member.id)).toEqual([]);

      // The same change, committed: one entry, in the same transaction.
      await new ReactivateMembership(transactions(), audit).execute(
        memberContext(owner),
        member.id,
      );
      expect(
        (await auditOf(tenant, member.id)).map(({ action }) => action),
      ).toEqual(['membership.reactivated']);
    }
  });

  describe('with a fault injected into the audit insert', () => {
    let isolated: IsolatedSchema;
    let db: ReturnType<typeof prismaFor>;
    let tenant: Tenant;
    let owner: User;

    // A schema of its own, so that the fault touches no other test's audit.
    beforeAll(async () => {
      isolated = await createIsolatedSchema();
      db = prismaFor(isolated.url);
      tenant = await createTenant({ prisma: db.prisma });
      owner = await createMember(tenant, 'OWNER', db.prisma);
      const { connectionString, options } = databaseConnectionOf(
        isolated.migrationUrl,
      );
      const migrator = new Client({ connectionString, options });
      await migrator.connect();
      try {
        await migrator.query(`
          CREATE FUNCTION fail_audit_insert() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'injected fault: the audit insert fails'; END $$;
          CREATE TRIGGER audit_logs_injected_fault BEFORE INSERT ON audit_logs
            FOR EACH ROW EXECUTE FUNCTION fail_audit_insert();`);
      } finally {
        await migrator.end();
      }
    });

    afterAll(async () => {
      await db?.close();
      await isolated?.drop();
    });

    it('a_failed_audit_insert_aborts_the_change', async () => {
      const tenants = new TenantTransactions(db.prisma);
      const ctx = memberContext(owner);

      // A reactivation: the member stays archived.
      const member = await archivedMember(tenant, db.prisma);
      await expect(
        new ReactivateMembership(tenants, audit).execute(ctx, member.id),
      ).rejects.toThrow(/injected fault/);
      expect(
        await asTenant(
          tenant.id,
          (tx) =>
            tx.user.findUniqueOrThrow({
              where: { id: member.id },
              select: { deletedAt: true, isActive: true },
            }),
          db.prisma,
        ),
      ).toEqual({ deletedAt: member.deletedAt, isActive: false });

      // An invitation: none is made.
      const email = `invitee-${suffix()}@agency.test`;
      await expect(
        new InviteMemberUseCase(
          tenants,
          new InvitationRepository(),
          provider,
          fixedClock(new Date()),
          audit,
        ).execute(ctx, { email, role: 'COACH' }),
      ).rejects.toThrow(/injected fault/);
      expect(
        await asTenant(
          tenant.id,
          (tx) => tx.invitation.count({ where: { normalizedEmail: email } }),
          db.prisma,
        ),
      ).toBe(0);
    });
  });

  it('audit_payloads_carry_no_confidential_values', async () => {
    // The users module's changes, through its use cases: an invitation made
    // and revoked, and a membership reactivated.
    const email = `Invitee.${suffix()}@agency.test`;
    const ctx = memberContext(ownerA);
    const invitation = await invitations().execute(ctx, {
      email,
      role: 'SCOUT',
      locale: 'ar',
    });
    await new ManageInvitationsUseCase(
      transactions(),
      new InvitationRepository(),
      fixedClock(new Date()),
      audit,
    ).revoke(ctx, invitation.id);
    const member = await archivedMember(a);
    await new ReactivateMembership(transactions(), audit).execute(
      ctx,
      member.id,
    );

    const rows = [
      ...(await auditOf(a, invitation.id)),
      ...(await auditOf(a, member.id)),
    ];
    expect(rows.map(({ action }) => action)).toEqual([
      'invitation.created',
      'invitation.revoked',
      'membership.reactivated',
    ]);
    // The address appears nowhere, in any column, in any case.
    expect(JSON.stringify(rows).toLowerCase()).not.toContain(
      email.toLowerCase(),
    );
    // It is a reference to where it lives.
    expect(rows[0].newValues).toEqual({
      email: { ref: `Invitation/${invitation.id}/email`, class: 'PERSONAL' },
      role: 'SCOUT',
      locale: 'ar',
      expiresAt: invitation.expiresAt.toISOString(),
    });
    // Every field of every payload is one its action allows, and every field
    // the catalog does not record as a value is a reference.
    for (const row of rows) {
      const { fields } = AUDITED_ACTIONS[row.action as AuditAction] as {
        fields: Record<string, string>;
      };
      for (const values of [row.oldValues, row.newValues]) {
        for (const [field, value] of Object.entries(
          (values ?? {}) as Record<string, unknown>,
        )) {
          expect([row.action, field, field in fields]).toEqual([
            row.action,
            field,
            true,
          ]);
          if (fields[field] !== 'OPERATIONAL') {
            expect([row.action, field, value]).toEqual([
              row.action,
              field,
              { ref: expect.any(String) as unknown, class: fields[field] },
            ]);
          }
        }
      }
      // Who, when, which request, in the structural shape of 0.7.2.
      expect(row).toMatchObject({
        tenantId: a.id,
        actorType: 'USER',
        userId: ownerA.id,
        actorRole: 'OWNER',
        requestId: ctx.requestId,
        outcome: 'SUCCEEDED',
        schemaVersion: 2,
      });
    }
    expect(rows[1]).toMatchObject({
      oldValues: { status: 'pending' },
      newValues: { status: 'revoked' },
    });

    // A field its action does not allow is refused, and the change with it.
    const before = await auditOf(a, member.id);
    await expect(
      asTenant(a.id, (tx) =>
        audit.record(tx, ctx, {
          action: 'membership.reactivated',
          entityId: member.id,
          after: { archivedAt: null, email } as never,
        }),
      ),
    ).rejects.toBeInstanceOf(AuditEventRefused);
    expect(await auditOf(a, member.id)).toEqual(before);
  });

  it('role_changes_record_before_and_after', async () => {
    // No route changes a member's role yet (1.1.x): the change it will make,
    // and its entry, in one tenant transaction.
    for (const [tenant, owner] of [
      [a, ownerA],
      [b, ownerB],
    ] as const) {
      const member = await createMember(tenant, 'COACH');
      const ctx = memberContext(owner);
      const changeRole = (event: AuditEvent<'member.role_changed'>) =>
        transactions().withTenantTransaction(ctx, async (tx) => {
          await tx.user.update({
            where: { id: member.id },
            data: { role: 'SCOUT' },
          });
          await audit.record(tx, ctx, event);
        });

      // Without the state before, refused — and the role stays as it was.
      await expect(
        changeRole({
          action: 'member.role_changed',
          entityId: member.id,
          after: { role: 'SCOUT' },
        }),
      ).rejects.toBeInstanceOf(AuditEventRefused);
      const roleOf = () =>
        asTenant(tenant.id, (tx) =>
          tx.user.findUniqueOrThrow({
            where: { id: member.id },
            select: { role: true },
          }),
        );
      expect(await roleOf()).toEqual({ role: 'COACH' });

      // With both: the change, and who made it, before and after.
      await changeRole({
        action: 'member.role_changed',
        entityId: member.id,
        before: { role: 'COACH' },
        after: { role: 'SCOUT' },
      });
      expect(await roleOf()).toEqual({ role: 'SCOUT' });
      expect(await auditOf(tenant, member.id)).toEqual([
        expect.objectContaining({
          action: 'member.role_changed',
          entityType: 'User',
          entityId: member.id,
          actorType: 'USER',
          userId: owner.id,
          actorRole: 'OWNER',
          oldValues: { role: 'COACH' },
          newValues: { role: 'SCOUT' },
          schemaVersion: 2,
        }),
      ]);
    }
  });

  it('the_client_is_kept_as_inet_and_never_aborts_the_change', async () => {
    const record = async (ctx: AuthorizedTenantContext) => {
      const member = await archivedMember(a);
      await new ReactivateMembership(transactions(), audit).execute(
        ctx,
        member.id,
      );
      const [row] = await auditOf(a, member.id);
      return { ipAddress: row.ipAddress, userAgent: row.userAgent };
    };
    // An address inet takes, kept as inet; an over-long user agent, cut.
    const userAgent = `Mozilla/5.0 ${'x'.repeat(2 * USER_AGENT_MAX)}`;
    expect(
      await record(
        memberContext(ownerA, { address: '2001:db8::7', userAgent }),
      ),
    ).toEqual({
      ipAddress: '2001:db8::7',
      userAgent: userAgent.slice(0, USER_AGENT_MAX),
    });
    // One inet would refuse: dropped, and the change commits all the same.
    expect(
      await record(memberContext(ownerA, { address: 'not-an-address' })),
    ).toEqual({ ipAddress: null, userAgent: null });
    // The column is inet.
    const { rows } = await runPrisma().$queryRaw<Array<{ type: string }>>`
      SELECT data_type AS type FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'audit_logs'
         AND column_name = 'ip_address'`.then((rows) => ({ rows }));
    expect(rows).toEqual([{ type: 'inet' }]);
  });
});
