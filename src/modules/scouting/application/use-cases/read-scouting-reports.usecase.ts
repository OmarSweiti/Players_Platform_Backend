import { Injectable } from '@nestjs/common';
import type { RecommendationLevel, ScoutReportStatus } from '@prisma/client';
import { authorizeRead } from '../../../../common/policy/policy';
import {
  actingMemberOf,
  type AuthorizedTenantContext,
} from '../../../../common/tenancy/tenant-context';
import { TenantTransactions } from '../../../../common/tenancy/tenant-transaction';
import { scoutingReportPolicy } from '../policies/scouting-report.policy';
import { ScoutingReports } from '../ports/scouting-reports.port';

/**
 * The scouting report reads (0.4.12): each in one tenant transaction, as the
 * context's tenant, live reports only.
 */
@Injectable()
export class ReadScoutingReportsUseCase {
  constructor(
    private readonly tenants: TenantTransactions,
    private readonly scoutingReportRepo: ScoutingReports,
  ) {}

  async list(
    ctx: AuthorizedTenantContext,
    filters: {
      status?: ScoutReportStatus;
      scoutId?: string;
      playerId?: string;
      recommendation?: RecommendationLevel;
      dateFrom?: Date;
      dateTo?: Date;
    },
    page: { skip?: number; take?: number },
  ) {
    const { reports } = await this.tenants.withTenantTransaction(ctx, (tx) =>
      this.scoutingReportRepo.findMany(tx, ctx, filters, page),
    );
    return reports;
  }

  get(ctx: AuthorizedTenantContext, id: string) {
    return this.tenants.withTenantTransaction(ctx, async (tx) =>
      authorizeRead(
        ctx,
        scoutingReportPolicy,
        await this.scoutingReportRepo.findById(tx, ctx, id),
        'Scouting report not found',
      ),
    );
  }

  /** The acting member's own report counts, as a scout. */
  myStats(ctx: AuthorizedTenantContext) {
    const scoutId = actingMemberOf(ctx);
    return this.tenants.withTenantTransaction(ctx, (tx) =>
      this.scoutingReportRepo.getStatsByScout(tx, ctx, scoutId),
    );
  }
}
