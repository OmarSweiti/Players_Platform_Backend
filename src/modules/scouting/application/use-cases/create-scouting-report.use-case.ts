import { Injectable } from '@nestjs/common';
import {
  ScoutingReportRepository,
  CreateScoutingReportInput,
} from '../../infrastructure/repositories/scouting-report.repository';
import { WatchlistRepository } from '../../infrastructure/repositories/watchlist.repository';
import { AssignmentRepository } from '../../infrastructure/repositories/assignment.repository';

@Injectable()
export class CreateScoutingReportUseCase {
  constructor(
    private readonly scoutingReportRepo: ScoutingReportRepository,
    private readonly watchlistRepo: WatchlistRepository,
  ) {}

  async execute(input: CreateScoutingReportInput) {
    // Validate evaluation scores (1-10 range)
    if (
      input.technicalScore &&
      (input.technicalScore < 1 || input.technicalScore > 10)
    ) {
      throw new Error('Technical score must be between 1 and 10');
    }
    if (
      input.physicalScore &&
      (input.physicalScore < 1 || input.physicalScore > 10)
    ) {
      throw new Error('Physical score must be between 1 and 10');
    }
    if (
      input.tacticalScore &&
      (input.tacticalScore < 1 || input.tacticalScore > 10)
    ) {
      throw new Error('Tactical score must be between 1 and 10');
    }
    if (
      input.mentalScore &&
      (input.mentalScore < 1 || input.mentalScore > 10)
    ) {
      throw new Error('Mental score must be between 1 and 10');
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

    // Create the report
    const report = await this.scoutingReportRepo.create(input);

    // If recommendation is STRONG_SIGN or SIGN, automatically add to watchlist
    if (
      input.recommendation &&
      (input.recommendation === 'STRONG_SIGN' ||
        input.recommendation === 'SIGN') &&
      input.playerId
    ) {
      await this.watchlistRepo.addToWatchlist(
        input.scoutId,
        input.tenantId,
        input.playerId,
        'HIGH',
        `Auto-added from scouting report: ${report.id}`,
      );
    }

    return report;
  }
}
