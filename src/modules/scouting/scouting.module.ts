import { Module } from '@nestjs/common';
import { ScoutingController } from './presentation/scouting.controller';
import { ScoutingReportRepository } from './infrastructure/repositories/scouting-report.repository';
import { ScoutingReports } from './application/ports/scouting-reports.port';
import { WatchlistRepository } from './infrastructure/repositories/watchlist.repository';
import { ScoutingDirectoryRepository } from './infrastructure/repositories/scouting-directory.repository';
import { ScoutingDirectory } from './application/ports/scouting-directory.port';
import { Watchlists } from './application/ports/watchlists.port';
import { AssignmentRepository } from './infrastructure/repositories/assignment.repository';
import { Assignments } from './application/ports/assignments.port';
import { CreateScoutingReportUseCase } from './application/use-cases/create-scouting-report.usecase';
import { UpdateScoutingReportUseCase } from './application/use-cases/update-scouting-report.usecase';
import { SubmitScoutingReportUseCase } from './application/use-cases/submit-scouting-report.usecase';
import { ApproveScoutingReportUseCase } from './application/use-cases/approve-scouting-report.usecase';
import { RejectScoutingReportUseCase } from './application/use-cases/reject-scouting-report.usecase';
import { ManageWatchlistUseCase } from './application/use-cases/manage-watchlist.usecase';
import { ManageAssignmentUseCase } from './application/use-cases/manage-assignment.usecase';
import { ReadScoutingReportsUseCase } from './application/use-cases/read-scouting-reports.usecase';
import { ArchiveScoutingReportUseCase } from './application/use-cases/archive-scouting-report.usecase';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { behindFeature } from '../../common/feature-flags/feature-gate.guard';

@Module({
  imports: [PrismaModule],
  // Quarantined until its rebuild: FEATURE_SCOUTING (0.1.8; 1.11.1–1.11.8).
  controllers: behindFeature('scouting', [ScoutingController]),
  providers: [
    // Ports, and the repositories that implement them (0.4.12)
    { provide: ScoutingReports, useClass: ScoutingReportRepository },
    { provide: Watchlists, useClass: WatchlistRepository },
    { provide: Assignments, useClass: AssignmentRepository },
    { provide: ScoutingDirectory, useClass: ScoutingDirectoryRepository },

    // Use Cases
    CreateScoutingReportUseCase,
    UpdateScoutingReportUseCase,
    SubmitScoutingReportUseCase,
    ApproveScoutingReportUseCase,
    RejectScoutingReportUseCase,
    ManageWatchlistUseCase,
    ManageAssignmentUseCase,
    ReadScoutingReportsUseCase,
    ArchiveScoutingReportUseCase,
  ],
  exports: [ScoutingReports, Watchlists, Assignments],
})
export class ScoutingModule {}
