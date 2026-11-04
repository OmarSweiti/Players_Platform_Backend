import { Injectable } from '@nestjs/common';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import { TenantTransactions } from '../../../../common/tenancy/tenant-transaction';
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
    await this.tenants.withTenantTransaction(ctx, (tx) =>
      this.scoutingReportRepo.archive(tx, ctx, id),
    );
  }
}
