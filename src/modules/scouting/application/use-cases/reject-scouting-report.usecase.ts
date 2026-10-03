import { Injectable } from '@nestjs/common';
import { ScoutingReportRepository } from '../../infrastructure/repositories/scouting-report.repository';
import {
  InvalidTransitionError,
  NotFoundError,
} from '../../../../common/errors/domain-error';

@Injectable()
export class RejectScoutingReportUseCase {
  constructor(private readonly scoutingReportRepo: ScoutingReportRepository) {}

  async execute(id: string, tenantId: string, _reason?: string) {
    const report = await this.scoutingReportRepo.findById(id, tenantId);

    if (!report) {
      throw new NotFoundError('Scouting report not found');
    }

    if (report.status !== 'SUBMITTED') {
      throw new InvalidTransitionError(
        'Only SUBMITTED reports can be rejected',
      );
    }

    return await this.scoutingReportRepo.rejectReport(id, tenantId);
  }
}
