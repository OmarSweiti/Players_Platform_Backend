import { Injectable } from '@nestjs/common';
import { ScoutingReports } from '../ports/scouting-reports.port';
import { InvalidTransitionError } from '../../../../common/errors/domain-error';
import { authorizeChange } from '../../../../common/policy/policy';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import { TenantTransactions } from '../../../../common/tenancy/tenant-transaction';
import { scoutingReportPolicy } from '../policies/scouting-report.policy';

@Injectable()
export class RejectScoutingReportUseCase {
  constructor(
    private readonly tenants: TenantTransactions,
    private readonly scoutingReportRepo: ScoutingReports,
  ) {}

  async execute(ctx: AuthorizedTenantContext, id: string) {
    return this.tenants.withTenantTransaction(ctx, async (tx) => {
      authorizeChange(
        ctx,
        scoutingReportPolicy,
        'reject',
        await this.scoutingReportRepo.findById(tx, ctx, id),
        'Scouting report not found',
        {
          STATE: () =>
            new InvalidTransitionError(
              'Only SUBMITTED reports can be rejected',
            ),
        },
      );

      return this.scoutingReportRepo.rejectReport(tx, ctx, id);
    });
  }
}
