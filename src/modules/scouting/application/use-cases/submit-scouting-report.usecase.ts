import { Injectable } from '@nestjs/common';
import { ScoutingReportRepository } from '../../infrastructure/repositories/scouting-report.repository';
import {
  ForbiddenError,
  InvalidTransitionError,
  NotFoundError,
  ValidationFailedError,
} from '../../../../common/errors/domain-error';

@Injectable()
export class SubmitScoutingReportUseCase {
  constructor(private readonly scoutingReportRepo: ScoutingReportRepository) {}

  async execute(id: string, tenantId: string, scoutId: string) {
    const report = await this.scoutingReportRepo.findById(id, tenantId);

    if (!report) {
      throw new NotFoundError('Scouting report not found');
    }

    if (report.scoutId !== scoutId) {
      throw new ForbiddenError(
        'Only the assigned scout can submit this report',
      );
    }

    if (report.status !== 'DRAFT') {
      throw new InvalidTransitionError(
        'Report must be in DRAFT status to submit',
      );
    }

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
          .map((field) => ({ field: `/${field}`, code: 'REQUIRED' as const })),
      );
    }

    return await this.scoutingReportRepo.submitReport(id, tenantId);
  }
}
