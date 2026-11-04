import { Injectable } from '@nestjs/common';
import {
  ConflictError,
  NotFoundError,
} from '../../../../common/errors/domain-error';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import { TenantTransactions } from '../../../../common/tenancy/tenant-transaction';

/**
 * Brings an archived member back (0.4.9; SR-ACL-002): the same membership, its
 * id and its history, never a second account — the address stays reserved to
 * it while it is archived. The change and its audit entry commit together; the
 * audit service of 0.7.2 takes over writing the entry.
 */
@Injectable()
export class ReactivateMembership {
  constructor(private readonly tenants: TenantTransactions) {}

  async execute(
    ctx: AuthorizedTenantContext,
    memberId: string,
  ): Promise<{ id: string }> {
    return this.tenants.withTenantTransaction(ctx, async (tx) => {
      const member = await tx.user.findFirst({
        where: { id: memberId, tenantId: ctx.tenantId },
        select: { id: true, deletedAt: true },
      });
      if (!member) throw new NotFoundError('Member not found');
      if (member.deletedAt === null) {
        throw new ConflictError('The membership is not archived');
      }
      await tx.user.update({
        where: { id_tenantId: { id: member.id, tenantId: ctx.tenantId } },
        data: { deletedAt: null, isActive: true },
      });
      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          userId: ctx.actor.kind === 'USER' ? ctx.actor.userId : null,
          action: 'membership.reactivated',
          entityType: 'User',
          entityId: member.id,
          oldValues: { archivedAt: member.deletedAt.toISOString() },
          newValues: { archivedAt: null },
        },
      });
      return { id: member.id };
    });
  }
}
