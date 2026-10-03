import {
  Controller,
  HttpCode,
  Get,
  Post,
  Body,
  Param,
  Query,
  Delete,
  Patch,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { PERMISSIONS } from '../../../shared/constants/permissions.constants';
import { CreateScoutingReportDto } from './dto/create-scouting-report.dto';
import { UpdateScoutingReportDto } from './dto/update-scouting-report.dto';
import { QueryScoutingReportsDto } from './dto/query-scouting-reports.dto';
import { AddToWatchlistDto } from './dto/add-to-watchlist.dto';
import { CreateAssignmentDto } from './dto/create-assignment.dto';
import { UpdateAssignmentDto } from './dto/update-assignment.dto';
import { ApproveScoutingReportDto } from './dto/update-scouting-report.dto';
import {
  AssignmentStatusDto,
  AssignmentsQuery,
} from './dto/update-assignment.dto';
import { IdParams, PlayerIdParams } from '../../../common/validation/schemas';
import { CreateScoutingReportUseCase } from '../application/use-cases/create-scouting-report.usecase';
import { UpdateScoutingReportUseCase } from '../application/use-cases/update-scouting-report.usecase';
import { SubmitScoutingReportUseCase } from '../application/use-cases/submit-scouting-report.usecase';
import { ApproveScoutingReportUseCase } from '../application/use-cases/approve-scouting-report.usecase';
import { RejectScoutingReportUseCase } from '../application/use-cases/reject-scouting-report.usecase';
import { ManageWatchlistUseCase } from '../application/use-cases/manage-watchlist.usecase';
import { ManageAssignmentUseCase } from '../application/use-cases/manage-assignment.usecase';
import { ScoutingReportRepository } from '../infrastructure/repositories/scouting-report.repository';
import { NotFoundError } from '../../../common/errors/domain-error';

@ApiTags('Scouting')
@ApiBearerAuth()
@Controller('scouting')
export class ScoutingController {
  constructor(
    private readonly createReportUseCase: CreateScoutingReportUseCase,
    private readonly updateReportUseCase: UpdateScoutingReportUseCase,
    private readonly submitReportUseCase: SubmitScoutingReportUseCase,
    private readonly approveReportUseCase: ApproveScoutingReportUseCase,
    private readonly rejectReportUseCase: RejectScoutingReportUseCase,
    private readonly manageWatchlistUseCase: ManageWatchlistUseCase,
    private readonly manageAssignmentUseCase: ManageAssignmentUseCase,
    private readonly scoutingReportRepo: ScoutingReportRepository,
  ) {}

  // ==================== SCOUTING REPORTS ====================

  @Post('reports')
  @Permissions(PERMISSIONS.SREPORT_CREATE)
  @ApiOperation({ summary: 'Create a new scouting report' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Report created successfully',
  })
  async createReport(
    @CurrentUser() user: any,
    @Body({ schema: CreateScoutingReportDto }) dto: CreateScoutingReportDto,
  ) {
    const report = await this.createReportUseCase.execute({
      ...dto,
      scoutId: user.id,
      tenantId: user.tenantId,
    });
    return report;
  }

  @Get('reports')
  @Permissions(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({ summary: 'Get all scouting reports' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'List of scouting reports',
  })
  async getReports(
    @CurrentUser() user: any,
    @Query({ schema: QueryScoutingReportsDto }) query: QueryScoutingReportsDto,
  ) {
    const { page, limit } = query;
    const skip = (page - 1) * limit;

    const filters = {
      status: query.status,
      scoutId: query.scoutId,
      playerId: query.playerId,
      recommendation: query.recommendation,
      dateFrom: query.dateFrom ? new Date(query.dateFrom) : undefined,
      dateTo: query.dateTo ? new Date(query.dateTo) : undefined,
    };

    const { reports } = await this.scoutingReportRepo.findMany(
      user.tenantId,
      filters,
      { skip, take: limit },
    );

    return reports;
  }

  @Get('reports/:id')
  @Permissions(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({ summary: 'Get scouting report by ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Scouting report details',
  })
  async getReport(
    @CurrentUser() user: any,
    @Param({ schema: IdParams }) { id }: IdParams,
  ) {
    const report = await this.scoutingReportRepo.findById(id, user.tenantId);

    if (!report) {
      throw new NotFoundError('Scouting report not found');
    }

    return report;
  }

  @Patch('reports/:id')
  @Permissions(PERMISSIONS.SREPORT_UPDATE)
  @ApiOperation({ summary: 'Update scouting report' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Report updated successfully',
  })
  async updateReport(
    @CurrentUser() user: any,
    @Param({ schema: IdParams }) { id }: IdParams,
    @Body({ schema: UpdateScoutingReportDto }) dto: UpdateScoutingReportDto,
  ) {
    const report = await this.updateReportUseCase.execute(
      id,
      user.tenantId,
      {
        ...dto,
        status: dto.status,
      },
      user.id,
    );

    return report;
  }

  @Post('reports/:id/submit')
  @HttpCode(HttpStatus.OK)
  @Permissions(PERMISSIONS.SREPORT_SUBMIT)
  @ApiOperation({ summary: 'Submit scouting report for review' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Report submitted successfully',
  })
  async submitReport(
    @CurrentUser() user: any,
    @Param({ schema: IdParams }) { id }: IdParams,
  ) {
    const report = await this.submitReportUseCase.execute(
      id,
      user.tenantId,
      user.id,
    );

    return report;
  }

  @Post('reports/:id/approve')
  @HttpCode(HttpStatus.OK)
  @Permissions(PERMISSIONS.SREPORT_APPROVE)
  @ApiOperation({ summary: 'Approve scouting report' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Report approved successfully',
  })
  async approveReport(
    @CurrentUser() user: any,
    @Param({ schema: IdParams }) { id }: IdParams,
    @Body({ schema: ApproveScoutingReportDto })
    { recommendation }: ApproveScoutingReportDto,
  ) {
    const report = await this.approveReportUseCase.execute(
      id,
      user.tenantId,
      recommendation,
    );

    return report;
  }

  @Post('reports/:id/reject')
  @HttpCode(HttpStatus.OK)
  @Permissions(PERMISSIONS.SREPORT_REJECT)
  @ApiOperation({ summary: 'Reject scouting report' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Report rejected successfully',
  })
  async rejectReport(
    @CurrentUser() user: any,
    @Param({ schema: IdParams }) { id }: IdParams,
  ) {
    const report = await this.rejectReportUseCase.execute(id, user.tenantId);

    return report;
  }

  @Delete('reports/:id')
  @Permissions(PERMISSIONS.SREPORT_DELETE)
  @ApiOperation({ summary: 'Delete scouting report' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Report deleted successfully',
  })
  async deleteReport(
    @CurrentUser() user: any,
    @Param({ schema: IdParams }) { id }: IdParams,
  ) {
    await this.scoutingReportRepo.softDelete(id, user.tenantId);
  }

  @Get('reports/stats/my-stats')
  @Permissions(PERMISSIONS.REPORT_VIEW)
  @ApiOperation({ summary: 'Get my scouting report statistics' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Scout statistics' })
  async getMyStats(@CurrentUser() user: any): Promise<unknown> {
    const stats = await this.scoutingReportRepo.getStatsByScout(
      user.id,
      user.tenantId,
    );

    return stats;
  }

  // ==================== WATCHLIST ====================

  @Post('watchlist')
  @Permissions(PERMISSIONS.WATCHLIST_MANAGE)
  @ApiOperation({ summary: 'Add player to watchlist' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Player added to watchlist',
  })
  async addToWatchlist(
    @CurrentUser() user: any,
    @Body({ schema: AddToWatchlistDto }) dto: AddToWatchlistDto,
  ) {
    const entry = await this.manageWatchlistUseCase.addToWatchlist(
      user.id,
      user.tenantId,
      dto.playerId,
      dto.priority,
      dto.notes,
    );

    return entry;
  }

  @Get('watchlist')
  @Permissions(PERMISSIONS.WATCHLIST_VIEW)
  @ApiOperation({ summary: 'Get my watchlist' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'List of watched players',
  })
  async getWatchlist(@CurrentUser() user: any) {
    const watchlist = await this.manageWatchlistUseCase.getWatchlist(
      user.id,
      user.tenantId,
    );

    return watchlist;
  }

  @Delete('watchlist/:playerId')
  @Permissions(PERMISSIONS.WATCHLIST_MANAGE)
  @ApiOperation({ summary: 'Remove player from watchlist' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Player removed from watchlist',
  })
  async removeFromWatchlist(
    @CurrentUser() user: any,
    @Param({ schema: PlayerIdParams }) { playerId }: PlayerIdParams,
  ) {
    await this.manageWatchlistUseCase.removeFromWatchlist(
      user.id,
      user.tenantId,
      playerId,
    );
  }

  @Get('watchlist/check/:playerId')
  @Permissions(PERMISSIONS.WATCHLIST_VIEW)
  @ApiOperation({ summary: 'Check if player is in watchlist' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Watchlist check result' })
  async checkWatchlist(
    @CurrentUser() user: any,
    @Param({ schema: PlayerIdParams }) { playerId }: PlayerIdParams,
  ) {
    const isInWatchlist = await this.manageWatchlistUseCase.isInWatchlist(
      user.id,
      user.tenantId,
      playerId,
    );

    return { isInWatchlist };
  }

  // ==================== ASSIGNMENTS ====================

  @Post('assignments')
  @Permissions(PERMISSIONS.ASSIGNMENT_MANAGE)
  @ApiOperation({ summary: 'Create scouting assignment' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Assignment created successfully',
  })
  async createAssignment(
    @CurrentUser() user: any,
    @Body({ schema: CreateAssignmentDto }) dto: CreateAssignmentDto,
  ) {
    const assignment = await this.manageAssignmentUseCase.createAssignment({
      ...dto,
      assignedById: user.id,
      tenantId: user.tenantId,
      dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
    });

    return assignment;
  }

  @Get('assignments/my-assignments')
  @Permissions(PERMISSIONS.ASSIGNMENT_VIEW)
  @ApiOperation({ summary: 'Get my assignments (for scouts)' })
  @ApiResponse({ status: HttpStatus.OK, description: 'List of assignments' })
  async getMyAssignments(
    @CurrentUser() user: any,
    @Query({ schema: AssignmentsQuery }) { status }: AssignmentsQuery,
  ) {
    const assignments =
      await this.manageAssignmentUseCase.getAssignmentsByScout(
        user.id,
        user.tenantId,
        status,
      );

    return assignments;
  }

  @Get('assignments/director-view')
  @Permissions(PERMISSIONS.ASSIGNMENT_VIEW)
  @ApiOperation({ summary: 'Get assignments created by director' })
  @ApiResponse({ status: HttpStatus.OK, description: 'List of assignments' })
  async getDirectorAssignments(
    @CurrentUser() user: any,
    @Query({ schema: AssignmentsQuery }) { status }: AssignmentsQuery,
  ) {
    const assignments =
      await this.manageAssignmentUseCase.getAssignmentsByDirector(
        user.id,
        user.tenantId,
        status,
      );

    return assignments;
  }

  @Patch('assignments/:id')
  @Permissions(PERMISSIONS.ASSIGNMENT_MANAGE)
  @ApiOperation({ summary: 'Update assignment' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Assignment updated successfully',
  })
  async updateAssignment(
    @CurrentUser() user: any,
    @Param({ schema: IdParams }) { id }: IdParams,
    @Body({ schema: UpdateAssignmentDto }) dto: UpdateAssignmentDto,
  ) {
    const assignment = await this.manageAssignmentUseCase.updateAssignment(
      id,
      user.tenantId,
      {
        ...dto,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
        status: dto.status || undefined,
      },
      user.id,
    );

    return assignment;
  }

  @Patch('assignments/:id/status')
  @Permissions(PERMISSIONS.ASSIGNMENT_UPDATE)
  @ApiOperation({ summary: 'Update assignment status' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Status updated successfully',
  })
  async updateAssignmentStatus(
    @CurrentUser() user: any,
    @Param({ schema: IdParams }) { id }: IdParams,
    @Body({ schema: AssignmentStatusDto }) { status }: AssignmentStatusDto,
  ) {
    const assignment = await this.manageAssignmentUseCase.updateStatus(
      id,
      user.tenantId,
      status,
      user.id,
      user.role,
    );

    return assignment;
  }

  @Delete('assignments/:id')
  @Permissions(PERMISSIONS.ASSIGNMENT_MANAGE)
  @ApiOperation({ summary: 'Delete assignment' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Assignment deleted successfully',
  })
  async deleteAssignment(
    @CurrentUser() user: any,
    @Param({ schema: IdParams }) { id }: IdParams,
  ) {
    await this.manageAssignmentUseCase.deleteAssignment(
      id,
      user.tenantId,
      user.id,
    );
  }
}
