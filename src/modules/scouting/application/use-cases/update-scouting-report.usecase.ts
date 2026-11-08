import { Injectable } from '@nestjs/common';
import {
  ScoutingReports,
  UpdateScoutingReportInput,
} from '../ports/scouting-reports.port';
import {
  ForbiddenError,
  InvalidTransitionError,
  ValidationFailedError,
} from '../../../../common/errors/domain-error';
import { authorizeChange } from '../../../../common/policy/policy';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import { TenantTransactions } from '../../../../common/tenancy/tenant-transaction';
import { scoutingReportPolicy } from '../policies/scouting-report.policy';

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

    return this.tenants.withTenantTransaction(ctx, async (tx) => {
      authorizeChange(
        ctx,
        scoutingReportPolicy,
        'update',
        await this.scoutingReportRepo.findById(tx, ctx, id),
        'Scouting report not found',
        {
          UNRELATED: () =>
            new ForbiddenError(
              'Only the assigned scout can update this report',
            ),
          STATE: () =>
            new InvalidTransitionError(
              'Cannot update a report that has already been submitted',
            ),
        },
      );
      return this.scoutingReportRepo.update(tx, ctx, id, input);
    });
  }
}
