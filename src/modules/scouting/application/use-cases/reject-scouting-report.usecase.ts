import { Injectable } from '@nestjs/common';
import { ScoutingReports } from '../ports/scouting-reports.port';
import {
  InvalidTransitionError,
  NotFoundError,
} from '../../../../common/errors/domain-error';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import { TenantTransactions } from '../../../../common/tenancy/tenant-transaction';

@Injectable()
export class RejectScoutingReportUseCase {
  constructor(
    private readonly tenants: TenantTransactions,
    private readonly scoutingReportRepo: ScoutingReports,
  ) {}

  async execute(ctx: AuthorizedTenantContext, id: string) {
    return this.tenants.withTenantTransaction(ctx, async (tx) => {
      const report = await this.scoutingReportRepo.findById(tx, ctx, id);

      if (!report) {
        throw new NotFoundError('Scouting report not found');
      }

      if (report.status !== 'SUBMITTED') {
        throw new InvalidTransitionError(
          'Only SUBMITTED reports can be rejected',
        );
      }

      return this.scoutingReportRepo.rejectReport(tx, ctx, id);
    });
  }
}
