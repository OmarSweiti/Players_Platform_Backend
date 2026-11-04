import { Injectable } from '@nestjs/common';
import { ScoutingReports } from '../ports/scouting-reports.port';
import { RecommendationLevel } from '@prisma/client';
import {
  InvalidTransitionError,
  NotFoundError,
} from '../../../../common/errors/domain-error';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import { TenantTransactions } from '../../../../common/tenancy/tenant-transaction';

@Injectable()
export class ApproveScoutingReportUseCase {
  constructor(
    private readonly tenants: TenantTransactions,
    private readonly scoutingReportRepo: ScoutingReports,
  ) {}

  async execute(
    ctx: AuthorizedTenantContext,
    id: string,
    recommendation: RecommendationLevel,
  ) {
    return this.tenants.withTenantTransaction(ctx, async (tx) => {
      const report = await this.scoutingReportRepo.findById(tx, ctx, id);

      if (!report) {
        throw new NotFoundError('Scouting report not found');
      }

      if (report.status !== 'SUBMITTED') {
        throw new InvalidTransitionError(
          'Only SUBMITTED reports can be approved',
        );
      }

      return this.scoutingReportRepo.approveReport(tx, ctx, id, recommendation);
    });
  }
}
