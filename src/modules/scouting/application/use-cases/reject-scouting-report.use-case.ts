import { Injectable } from '@nestjs/common';
import { ScoutingReportRepository } from '../../infrastructure/repositories/scouting-report.repository';

@Injectable()
export class RejectScoutingReportUseCase {
  constructor(
    private readonly scoutingReportRepo: ScoutingReportRepository,
  ) {}

  async execute(id: string, tenantId: string, reason?: string) {
    const report = await this.scoutingReportRepo.findById(id, tenantId);
    
    if (!report) {
      throw new Error('Scouting report not found');
    }

    if (report.status !== 'SUBMITTED') {
      throw new Error('Only SUBMITTED reports can be rejected');
    }

    return await this.scoutingReportRepo.rejectReport(id, tenantId);
  }
}
