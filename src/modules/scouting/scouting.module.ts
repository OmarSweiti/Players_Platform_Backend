import { Module } from '@nestjs/common';
import { ScoutingController } from './presentation/scouting.controller';
import { ScoutingReportRepository } from './infrastructure/repositories/scouting-report.repository';
import { WatchlistRepository } from './infrastructure/repositories/watchlist.repository';
import { AssignmentRepository } from './infrastructure/repositories/assignment.repository';
import { CreateScoutingReportUseCase } from './application/use-cases/create-scouting-report.use-case';
import { UpdateScoutingReportUseCase } from './application/use-cases/update-scouting-report.use-case';
import { SubmitScoutingReportUseCase } from './application/use-cases/submit-scouting-report.use-case';
import { ApproveScoutingReportUseCase } from './application/use-cases/approve-scouting-report.use-case';
import { RejectScoutingReportUseCase } from './application/use-cases/reject-scouting-report.use-case';
import { ManageWatchlistUseCase } from './application/use-cases/manage-watchlist.use-case';
import { ManageAssignmentUseCase } from './application/use-cases/manage-assignment.use-case';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { behindFeature } from '../../common/feature-flags/feature-gate.guard';

@Module({
  imports: [PrismaModule],
  // Quarantined until its rebuild: FEATURE_SCOUTING (0.1.8; 1.11.1–1.11.8).
  controllers: behindFeature('scouting', [ScoutingController]),
  providers: [
    // Repositories
    ScoutingReportRepository,
    WatchlistRepository,
    AssignmentRepository,

    // Use Cases
    CreateScoutingReportUseCase,
    UpdateScoutingReportUseCase,
    SubmitScoutingReportUseCase,
    ApproveScoutingReportUseCase,
    RejectScoutingReportUseCase,
    ManageWatchlistUseCase,
    ManageAssignmentUseCase,
  ],
  exports: [
    ScoutingReportRepository,
    WatchlistRepository,
    AssignmentRepository,
  ],
})
export class ScoutingModule {}
