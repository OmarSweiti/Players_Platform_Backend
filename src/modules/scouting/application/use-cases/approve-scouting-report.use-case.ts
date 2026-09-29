import { Injectable } from '@nestjs/common';
import { ScoutingReportRepository } from '../../infrastructure/repositories/scouting-report.repository';
import { RecommendationLevel } from '@prisma/client';

@Injectable()
export class ApproveScoutingReportUseCase {
  constructor(private readonly scoutingReportRepo: ScoutingReportRepository) {}

  async execute(
    id: string,
    tenantId: string,
    recommendation: RecommendationLevel,
  ) {
    const report = await this.scoutingReportRepo.findById(id, tenantId);

    if (!report) {
      throw new Error('Scouting report not found');
    }

    if (report.status !== 'SUBMITTED') {
      throw new Error('Only SUBMITTED reports can be approved');
    }

    return await this.scoutingReportRepo.approveReport(
      id,
      tenantId,
      recommendation,
    );
  }
}
