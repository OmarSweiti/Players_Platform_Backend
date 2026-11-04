import { Injectable } from '@nestjs/common';
import type { TreatmentStatus } from '@prisma/client';
import { NotFoundError } from '../../../../common/errors/domain-error';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import { TenantTransactions } from '../../../../common/tenancy/tenant-transaction';
import { TreatmentSessions } from '../ports/treatment-sessions.port';

/** The treatment session reads (0.4.12): each in one tenant transaction, as the context's tenant. */
@Injectable()
export class ReadTreatmentSessionsUseCase {
  constructor(
    private readonly tenants: TenantTransactions,
    private readonly treatmentSessionRepo: TreatmentSessions,
  ) {}

  async forPlayer(
    ctx: AuthorizedTenantContext,
    playerId: string,
    filters: {
      status?: TreatmentStatus;
      medicalRecordId?: string;
      dateFrom?: Date;
      dateTo?: Date;
    },
    page: { skip?: number; take?: number },
  ) {
    const { sessions } = await this.tenants.withTenantTransaction(ctx, (tx) =>
      this.treatmentSessionRepo.findByPlayer(tx, ctx, playerId, filters, page),
    );
    return sessions;
  }

  async get(ctx: AuthorizedTenantContext, id: string) {
    const session = await this.tenants.withTenantTransaction(ctx, (tx) =>
      this.treatmentSessionRepo.findById(tx, ctx, id),
    );
    if (!session) throw new NotFoundError('Treatment session not found');
    return session;
  }

  upcoming(ctx: AuthorizedTenantContext, playerId: string) {
    return this.tenants.withTenantTransaction(ctx, (tx) =>
      this.treatmentSessionRepo.getUpcomingSessions(tx, ctx, playerId),
    );
  }

  stats(ctx: AuthorizedTenantContext, playerId: string) {
    return this.tenants.withTenantTransaction(ctx, (tx) =>
      this.treatmentSessionRepo.getSessionStats(tx, ctx, playerId),
    );
  }
}
