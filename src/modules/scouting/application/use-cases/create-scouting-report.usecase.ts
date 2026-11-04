import { Injectable } from '@nestjs/common';
import {
  ScoutingReports,
  CreateScoutingReportInput,
} from '../ports/scouting-reports.port';
import { Watchlists } from '../ports/watchlists.port';
import { ValidationFailedError } from '../../../../common/errors/domain-error';
import {
  actingMemberOf,
  type AuthorizedTenantContext,
} from '../../../../common/tenancy/tenant-context';
import { TenantTransactions } from '../../../../common/tenancy/tenant-transaction';

@Injectable()
export class CreateScoutingReportUseCase {
  constructor(
    private readonly tenants: TenantTransactions,
    private readonly scoutingReportRepo: ScoutingReports,
    private readonly watchlistRepo: Watchlists,
  ) {}

  /**
   * The report is the context's tenant's, by the acting member as its scout;
   * with its automatic watchlist entry, in one transaction.
   */
  async execute(
    ctx: AuthorizedTenantContext,
    input: Omit<CreateScoutingReportInput, 'scoutId'>,
  ) {
    // Validate evaluation scores (1-10 range)
    if (
      input.technicalScore &&
      (input.technicalScore < 1 || input.technicalScore > 10)
    ) {
      throw new ValidationFailedError(
        'Technical score must be between 1 and 10',
        [{ field: '/technicalScore', code: 'OUT_OF_RANGE' }],
      );
    }
    if (
      input.physicalScore &&
      (input.physicalScore < 1 || input.physicalScore > 10)
    ) {
      throw new ValidationFailedError(
        'Physical score must be between 1 and 10',
        [{ field: '/physicalScore', code: 'OUT_OF_RANGE' }],
      );
    }
    if (
      input.tacticalScore &&
      (input.tacticalScore < 1 || input.tacticalScore > 10)
    ) {
      throw new ValidationFailedError(
        'Tactical score must be between 1 and 10',
        [{ field: '/tacticalScore', code: 'OUT_OF_RANGE' }],
      );
    }
    if (
      input.mentalScore &&
      (input.mentalScore < 1 || input.mentalScore > 10)
    ) {
      throw new ValidationFailedError('Mental score must be between 1 and 10', [
        { field: '/mentalScore', code: 'OUT_OF_RANGE' },
      ]);
    }

    // Calculate overall rating if all scores provided
    if (
      input.technicalScore &&
      input.physicalScore &&
      input.tacticalScore &&
      input.mentalScore
    ) {
      const average =
        (Number(input.technicalScore) +
          Number(input.physicalScore) +
          Number(input.tacticalScore) +
          Number(input.mentalScore)) /
        4;
      input.overallRating = average;
    }

    const scoutId = actingMemberOf(ctx);
    return this.tenants.withTenantTransaction(ctx, async (tx) => {
      const report = await this.scoutingReportRepo.create(tx, ctx, {
        ...input,
        scoutId,
      });

      // If recommendation is STRONG_SIGN or SIGN, automatically add to watchlist
      if (
        input.recommendation &&
        (input.recommendation === 'STRONG_SIGN' ||
          input.recommendation === 'SIGN') &&
        input.playerId
      ) {
        await this.watchlistRepo.addToWatchlist(
          tx,
          ctx,
          scoutId,
          input.playerId,
          'HIGH',
          `Auto-added from scouting report: ${report.id}`,
        );
      }

      return report;
    });
  }
}
