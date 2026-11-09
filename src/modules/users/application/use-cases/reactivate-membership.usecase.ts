import { Injectable } from '@nestjs/common';
import { ConflictError } from '../../../../common/errors/domain-error';
import { authorizeChange } from '../../../../common/policy/policy';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import { TenantTransactions } from '../../../../common/tenancy/tenant-transaction';
import { AuditService } from '../../../../infrastructure/audit/audit.service';
import { membershipPolicy } from '../policies/membership.policy';

/**
 * Brings an archived member back (0.4.9; SR-ACL-002): the same membership, its
 * id and its history, never a second account — the address stays reserved to
 * it while it is archived. The change and its audit entry commit together
 * (0.7.2): an entry that cannot be written aborts the reactivation.
 */
@Injectable()
export class ReactivateMembership {
  constructor(
    private readonly tenants: TenantTransactions,
    private readonly audit: AuditService,
  ) {}

  async execute(
    ctx: AuthorizedTenantContext,
    memberId: string,
  ): Promise<{ id: string }> {
    return this.tenants.withTenantTransaction(ctx, async (tx) => {
      const member = authorizeChange(
        ctx,
        membershipPolicy,
        'reactivate',
        await tx.user.findFirst({
          where: { id: memberId, tenantId: ctx.tenantId },
          select: { id: true, deletedAt: true },
        }),
        'Member not found',
        { STATE: () => new ConflictError('The membership is not archived') },
      );
      // The policy brings back an archived membership only.
      const archivedAt = member.deletedAt as Date;
      await tx.user.update({
        where: { id_tenantId: { id: member.id, tenantId: ctx.tenantId } },
        data: { deletedAt: null, isActive: true },
      });
      await this.audit.record(tx, ctx, {
        action: 'membership.reactivated',
        entityId: member.id,
        before: { archivedAt },
        after: { archivedAt: null },
      });
      return { id: member.id };
    });
  }
}
