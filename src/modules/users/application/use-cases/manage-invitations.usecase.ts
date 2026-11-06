import { Inject, Injectable } from '@nestjs/common';
import {
  InvalidTransitionError,
  NotFoundError,
} from '../../../../common/errors/domain-error';
import { type Page, paginate } from '../../../../common/pagination/paginate';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import { TenantTransactions } from '../../../../common/tenancy/tenant-transaction';
import { CLOCK, type Clock } from '../../../../common/time/clock';
import { type InvitationStatus, statusOf } from '../../domain/invitation';
import {
  InvitationRecords,
  type ListedInvitation,
} from '../ports/invitation-records.port';

/**
 * The tenant's invitations (0.5.10): the list — pending, accepted, expired
 * and revoked, newest first — and revoking one. Only an open invitation can
 * be revoked; revoking a revoked one changes nothing, and an accepted one
 * stays accepted. A revocation is audited.
 */
@Injectable()
export class ManageInvitationsUseCase {
  constructor(
    private readonly transactions: TenantTransactions,
    private readonly records: InvitationRecords,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  list(
    ctx: AuthorizedTenantContext,
    query: { limit: number; cursor?: string; status?: InvitationStatus },
  ): Promise<Page<ListedInvitation>> {
    const at = this.clock.now();
    return this.transactions.withTenantTransaction(ctx, (tx) =>
      paginate(
        {
          limit: query.limit,
          cursor: query.cursor,
          // A cursor is this tenant's, for this status: another is refused.
          scope: {
            tenantId: ctx.tenantId,
            filters: { status: query.status ?? null },
            sort: 'createdAt.desc',
          },
        },
        async (args) =>
          (
            await this.records.list(tx, ctx, { status: query.status, at }, args)
          ).map((invitation) => ({
            ...invitation,
            status: statusOf(invitation, at),
          })),
      ),
    );
  }

  async revoke(
    ctx: AuthorizedTenantContext,
    invitationId: string,
  ): Promise<void> {
    await this.transactions.withTenantTransaction(ctx, async (tx) => {
      const invitation = await this.records.find(tx, ctx, invitationId);
      if (!invitation) throw new NotFoundError('No such invitation');
      if (invitation.revokedAt !== null) return;
      const at = this.clock.now();
      if (
        invitation.acceptedAt !== null ||
        !(await this.records.revoke(tx, ctx, invitationId, at))
      ) {
        throw new InvalidTransitionError(
          'an accepted invitation stays accepted',
        );
      }
      await this.records.audit(tx, ctx, {
        action: 'invitation.revoked',
        invitationId,
        oldValues: { status: statusOf(invitation, at) },
        newValues: { status: 'revoked' },
      });
    });
  }
}
