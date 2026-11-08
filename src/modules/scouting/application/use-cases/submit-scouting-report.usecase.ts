import { Injectable } from '@nestjs/common';
import { ScoutingReports } from '../ports/scouting-reports.port';
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
export class SubmitScoutingReportUseCase {
  constructor(
    private readonly tenants: TenantTransactions,
    private readonly scoutingReportRepo: ScoutingReports,
  ) {}

  async execute(ctx: AuthorizedTenantContext, id: string) {
    return this.tenants.withTenantTransaction(ctx, async (tx) => {
      const report = authorizeChange(
        ctx,
        scoutingReportPolicy,
        'submit',
        await this.scoutingReportRepo.findById(tx, ctx, id),
        'Scouting report not found',
        {
          UNRELATED: () =>
            new ForbiddenError(
              'Only the assigned scout can submit this report',
            ),
          STATE: () =>
            new InvalidTransitionError(
              'Report must be in DRAFT status to submit',
            ),
        },
      );

      // Validate required fields before submission
      if (!report.overallRating) {
        throw new ValidationFailedError(
          'Overall rating is required before submission',
          [{ field: '/overallRating', code: 'REQUIRED' }],
        );
      }

      if (!report.strengths || !report.weaknesses) {
        throw new ValidationFailedError(
          'Strengths and weaknesses are required before submission',
          (['strengths', 'weaknesses'] as const)
            .filter((field) => !report[field])
            .map((field) => ({
              field: `/${field}`,
              code: 'REQUIRED' as const,
            })),
        );
      }

      return this.scoutingReportRepo.submitReport(tx, ctx, id);
    });
  }
}
