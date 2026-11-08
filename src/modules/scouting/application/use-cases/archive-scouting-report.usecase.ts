import { Injectable } from '@nestjs/common';
import { authorizeChange } from '../../../../common/policy/policy';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import { TenantTransactions } from '../../../../common/tenancy/tenant-transaction';
import { scoutingReportPolicy } from '../policies/scouting-report.policy';
import { ScoutingReports } from '../ports/scouting-reports.port';

/**
 * Archives a scouting report (0.4.12): it leaves every ordinary read (DB-57).
 * One already archived, or another tenant's, is not found.
 */
@Injectable()
export class ArchiveScoutingReportUseCase {
  constructor(
    private readonly tenants: TenantTransactions,
    private readonly scoutingReportRepo: ScoutingReports,
  ) {}

  async execute(ctx: AuthorizedTenantContext, id: string): Promise<void> {
    await this.tenants.withTenantTransaction(ctx, async (tx) => {
      authorizeChange(
        ctx,
        scoutingReportPolicy,
        'archive',
        await this.scoutingReportRepo.findById(tx, ctx, id),
        'Scouting report not found',
      );
      await this.scoutingReportRepo.archive(tx, ctx, id);
    });
  }
}
