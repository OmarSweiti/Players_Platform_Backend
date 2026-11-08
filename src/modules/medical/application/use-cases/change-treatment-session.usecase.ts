import { Injectable } from '@nestjs/common';
import type { TreatmentStatus } from '@prisma/client';
import { authorizeChange } from '../../../../common/policy/policy';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import { TenantTransactions } from '../../../../common/tenancy/tenant-transaction';
import { treatmentSessionPolicy } from '../policies/treatment-session.policy';
import { TreatmentSessions } from '../ports/treatment-sessions.port';

/**
 * A treatment session's status, and its deletion, on the tenant transaction
 * (0.4.12). Transitions arrive with `2.1.3`; the archive with `0.6.8`.
 */
@Injectable()
export class ChangeTreatmentSessionUseCase {
  constructor(
    private readonly tenants: TenantTransactions,
    private readonly treatmentSessionRepo: TreatmentSessions,
  ) {}

  setStatus(ctx: AuthorizedTenantContext, id: string, status: TreatmentStatus) {
    return this.tenants.withTenantTransaction(ctx, async (tx) => {
      authorizeChange(
        ctx,
        treatmentSessionPolicy,
        'setStatus',
        await this.treatmentSessionRepo.findById(tx, ctx, id),
        'Treatment session not found',
      );
      return this.treatmentSessionRepo.updateStatus(tx, ctx, id, status);
    });
  }

  async delete(ctx: AuthorizedTenantContext, id: string): Promise<void> {
    await this.tenants.withTenantTransaction(ctx, async (tx) => {
      authorizeChange(
        ctx,
        treatmentSessionPolicy,
        'delete',
        await this.treatmentSessionRepo.findById(tx, ctx, id),
        'Treatment session not found',
      );
      await this.treatmentSessionRepo.delete(tx, ctx, id);
    });
  }
}
