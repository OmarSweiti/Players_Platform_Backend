import { Injectable } from '@nestjs/common';
import {
  ScoutingReportRepository,
  UpdateScoutingReportInput,
} from '../../infrastructure/repositories/scouting-report.repository';
import {
  ForbiddenError,
  InvalidTransitionError,
  NotFoundError,
  ValidationFailedError,
} from '../../../../common/errors/domain-error';

@Injectable()
export class UpdateScoutingReportUseCase {
  constructor(private readonly scoutingReportRepo: ScoutingReportRepository) {}

  async execute(
    id: string,
    tenantId: string,
    input: UpdateScoutingReportInput,
    scoutId: string,
  ) {
    // Verify ownership - only the scout who created the report can update it (unless DRAFT status)
    const report = await this.scoutingReportRepo.findById(id, tenantId);

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

    return await this.scoutingReportRepo.update(id, tenantId, input);
  }
}
