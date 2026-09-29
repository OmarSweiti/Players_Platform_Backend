import { Injectable } from '@nestjs/common';
import { ScoutingReportRepository } from '../../infrastructure/repositories/scouting-report.repository';

@Injectable()
export class SubmitScoutingReportUseCase {
  constructor(private readonly scoutingReportRepo: ScoutingReportRepository) {}

  async execute(id: string, tenantId: string, scoutId: string) {
    const report = await this.scoutingReportRepo.findById(id, tenantId);

    if (!report) {
      throw new Error('Scouting report not found');
    }

    if (report.scoutId !== scoutId) {
      throw new Error('Only the assigned scout can submit this report');
    }

    if (report.status !== 'DRAFT') {
      throw new Error('Report must be in DRAFT status to submit');
    }

    // Validate required fields before submission
    if (!report.overallRating) {
      throw new Error('Overall rating is required before submission');
    }

    if (!report.strengths || !report.weaknesses) {
      throw new Error(
        'Strengths and weaknesses are required before submission',
      );
    }

    return await this.scoutingReportRepo.submitReport(id, tenantId);
  }
}
