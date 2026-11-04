import { Injectable } from '@nestjs/common';
import type { TreatmentStatus } from '@prisma/client';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import { TenantTransactions } from '../../../../common/tenancy/tenant-transaction';
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
    return this.tenants.withTenantTransaction(ctx, (tx) =>
      this.treatmentSessionRepo.updateStatus(tx, ctx, id, status),
    );
  }

  async delete(ctx: AuthorizedTenantContext, id: string): Promise<void> {
    await this.tenants.withTenantTransaction(ctx, (tx) =>
      this.treatmentSessionRepo.delete(tx, ctx, id),
    );
  }
}
