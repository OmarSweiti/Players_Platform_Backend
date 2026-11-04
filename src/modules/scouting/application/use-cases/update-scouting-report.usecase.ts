import { Injectable } from '@nestjs/common';
import {
  ScoutingReports,
  UpdateScoutingReportInput,
} from '../ports/scouting-reports.port';
import {
  ForbiddenError,
  InvalidTransitionError,
  NotFoundError,
  ValidationFailedError,
} from '../../../../common/errors/domain-error';
import {
  actingMemberOf,
  type AuthorizedTenantContext,
} from '../../../../common/tenancy/tenant-context';
import { TenantTransactions } from '../../../../common/tenancy/tenant-transaction';

@Injectable()
export class UpdateScoutingReportUseCase {
  constructor(
    private readonly tenants: TenantTransactions,
    private readonly scoutingReportRepo: ScoutingReports,
  ) {}

  async execute(
    ctx: AuthorizedTenantContext,
    id: string,
    input: UpdateScoutingReportInput,
  ) {
    // Validate evaluation scores if provided
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

    // Recalculate overall rating if all scores are being updated
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
      // Verify ownership - only the scout who created the report can update it (unless DRAFT status)
      const report = await this.scoutingReportRepo.findById(tx, ctx, id);

      if (!report) {
        throw new NotFoundError('Scouting report not found');
      }

      if (report.scoutId !== scoutId && report.status !== 'DRAFT') {
        throw new ForbiddenError(
          'Only the assigned scout can update this report',
        );
      }

      if (report.status !== 'DRAFT') {
        throw new InvalidTransitionError(
          'Cannot update a report that has already been submitted',
        );
      }

      return this.scoutingReportRepo.update(tx, ctx, id, input);
    });
  }
}
