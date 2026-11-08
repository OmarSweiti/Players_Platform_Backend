import { Injectable } from '@nestjs/common';
import { ScoutingReports } from '../ports/scouting-reports.port';
import { RecommendationLevel } from '@prisma/client';
import { InvalidTransitionError } from '../../../../common/errors/domain-error';
import { authorizeChange } from '../../../../common/policy/policy';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import { TenantTransactions } from '../../../../common/tenancy/tenant-transaction';
import { scoutingReportPolicy } from '../policies/scouting-report.policy';

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
      authorizeChange(
        ctx,
        scoutingReportPolicy,
        'approve',
        await this.scoutingReportRepo.findById(tx, ctx, id),
        'Scouting report not found',
        {
          STATE: () =>
            new InvalidTransitionError(
              'Only SUBMITTED reports can be approved',
            ),
        },
      );

      return this.scoutingReportRepo.approveReport(tx, ctx, id, recommendation);
    });
  }
}
