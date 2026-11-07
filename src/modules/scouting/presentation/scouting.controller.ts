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
import type { SessionMember } from '../../../common/interfaces/request-with-user.interface';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { CurrentTenantContext } from '../../../common/decorators/tenant-context.decorator';
import type { AuthorizedTenantContext } from '../../../common/tenancy/tenant-context';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { RequiresRecentAuth } from '../../../common/decorators/requires-recent-auth.decorator';
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
import { ReadScoutingReportsUseCase } from '../application/use-cases/read-scouting-reports.usecase';
import { ArchiveScoutingReportUseCase } from '../application/use-cases/archive-scouting-report.usecase';

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
    private readonly readReports: ReadScoutingReportsUseCase,
    private readonly archiveReport: ArchiveScoutingReportUseCase,
  ) {}

  // ==================== SCOUTING REPORTS ====================

  @Post('reports')
  @Permissions('scouting.report.create')
  @ApiOperation({ summary: 'Create a new scouting report' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Report created successfully',
  })
  async createReport(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @Body({ schema: CreateScoutingReportDto }) dto: CreateScoutingReportDto,
  ) {
    const report = await this.createReportUseCase.execute(ctx, dto);
    return report;
  }

  @Get('reports')
  @Permissions('report.view')
  @ApiOperation({ summary: 'Get all scouting reports' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'List of scouting reports',
  })
  async getReports(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
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

    return this.readReports.list(ctx, filters, { skip, take: limit });
  }

  @Get('reports/:id')
  @Permissions('report.view')
  @ApiOperation({ summary: 'Get scouting report by ID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Scouting report details',
  })
  async getReport(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @Param({ schema: IdParams }) { id }: IdParams,
  ) {
    return this.readReports.get(ctx, id);
  }

  @Patch('reports/:id')
  @Permissions('scouting.report.update')
  @ApiOperation({ summary: 'Update scouting report' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Report updated successfully',
  })
  async updateReport(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @Param({ schema: IdParams }) { id }: IdParams,
    @Body({ schema: UpdateScoutingReportDto }) dto: UpdateScoutingReportDto,
  ) {
    const report = await this.updateReportUseCase.execute(ctx, id, {
      ...dto,
      status: dto.status,
    });

    return report;
  }

  @Post('reports/:id/submit')
  @HttpCode(HttpStatus.OK)
  @Permissions('scouting.report.submit')
  @ApiOperation({ summary: 'Submit scouting report for review' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Report submitted successfully',
  })
  async submitReport(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @Param({ schema: IdParams }) { id }: IdParams,
  ) {
    const report = await this.submitReportUseCase.execute(ctx, id);

    return report;
  }

  @Post('reports/:id/approve')
  @HttpCode(HttpStatus.OK)
  @Permissions('scouting.report.approve')
  // An approval decision: a recent authentication (0.5.8).
  @RequiresRecentAuth()
  @ApiOperation({ summary: 'Approve scouting report' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Report approved successfully',
  })
  async approveReport(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @Param({ schema: IdParams }) { id }: IdParams,
    @Body({ schema: ApproveScoutingReportDto })
    { recommendation }: ApproveScoutingReportDto,
  ) {
    const report = await this.approveReportUseCase.execute(
      ctx,
      id,
      recommendation,
    );

    return report;
  }

  @Post('reports/:id/reject')
  @HttpCode(HttpStatus.OK)
  @Permissions('scouting.report.reject')
  // An approval decision: a recent authentication (0.5.8).
  @RequiresRecentAuth()
  @ApiOperation({ summary: 'Reject scouting report' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Report rejected successfully',
  })
  async rejectReport(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @Param({ schema: IdParams }) { id }: IdParams,
  ) {
    const report = await this.rejectReportUseCase.execute(ctx, id);

    return report;
  }

  @Delete('reports/:id')
  @Permissions('scouting.report.delete')
  @ApiOperation({ summary: 'Delete scouting report' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Report deleted successfully',
  })
  async deleteReport(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @Param({ schema: IdParams }) { id }: IdParams,
  ) {
    await this.archiveReport.execute(ctx, id);
  }

  @Get('reports/stats/my-stats')
  @Permissions('report.view')
  @ApiOperation({ summary: 'Get my scouting report statistics' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Scout statistics' })
  async getMyStats(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
  ): Promise<unknown> {
    return this.readReports.myStats(ctx);
  }

  // ==================== WATCHLIST ====================

  @Post('watchlist')
  @Permissions('scouting.watchlist.manage')
  @ApiOperation({ summary: 'Add player to watchlist' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Player added to watchlist',
  })
  async addToWatchlist(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @Body({ schema: AddToWatchlistDto }) dto: AddToWatchlistDto,
  ) {
    const entry = await this.manageWatchlistUseCase.addToWatchlist(
      ctx,
      dto.playerId,
      dto.priority,
      dto.notes,
    );

    return entry;
  }

  @Get('watchlist')
  @Permissions('scouting.watchlist.view')
  @ApiOperation({ summary: 'Get my watchlist' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'List of watched players',
  })
  async getWatchlist(@CurrentTenantContext() ctx: AuthorizedTenantContext) {
    const watchlist = await this.manageWatchlistUseCase.getWatchlist(ctx);

    return watchlist;
  }

  @Delete('watchlist/:playerId')
  @Permissions('scouting.watchlist.manage')
  @ApiOperation({ summary: 'Remove player from watchlist' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Player removed from watchlist',
  })
  async removeFromWatchlist(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @Param({ schema: PlayerIdParams }) { playerId }: PlayerIdParams,
  ) {
    await this.manageWatchlistUseCase.removeFromWatchlist(ctx, playerId);
  }

  @Get('watchlist/check/:playerId')
  @Permissions('scouting.watchlist.view')
  @ApiOperation({ summary: 'Check if player is in watchlist' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Watchlist check result' })
  async checkWatchlist(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @Param({ schema: PlayerIdParams }) { playerId }: PlayerIdParams,
  ) {
    const isInWatchlist = await this.manageWatchlistUseCase.isInWatchlist(
      ctx,
      playerId,
    );

    return { isInWatchlist };
  }

  // ==================== ASSIGNMENTS ====================

  @Post('assignments')
  @Permissions('scouting.assignment.manage')
  @ApiOperation({ summary: 'Create scouting assignment' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Assignment created successfully',
  })
  async createAssignment(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @Body({ schema: CreateAssignmentDto }) dto: CreateAssignmentDto,
  ) {
    const assignment = await this.manageAssignmentUseCase.createAssignment(
      ctx,
      {
        ...dto,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
      },
    );

    return assignment;
  }

  @Get('assignments/my-assignments')
  @Permissions('scouting.assignment.view')
  @ApiOperation({ summary: 'Get my assignments (for scouts)' })
  @ApiResponse({ status: HttpStatus.OK, description: 'List of assignments' })
  async getMyAssignments(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @Query({ schema: AssignmentsQuery }) { status }: AssignmentsQuery,
  ) {
    const assignments =
      await this.manageAssignmentUseCase.getAssignmentsByScout(ctx, status);

    return assignments;
  }

  @Get('assignments/director-view')
  @Permissions('scouting.assignment.view')
  @ApiOperation({ summary: 'Get assignments created by director' })
  @ApiResponse({ status: HttpStatus.OK, description: 'List of assignments' })
  async getDirectorAssignments(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @Query({ schema: AssignmentsQuery }) { status }: AssignmentsQuery,
  ) {
    const assignments =
      await this.manageAssignmentUseCase.getAssignmentsByDirector(ctx, status);

    return assignments;
  }

  @Patch('assignments/:id')
  @Permissions('scouting.assignment.manage')
  @ApiOperation({ summary: 'Update assignment' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Assignment updated successfully',
  })
  async updateAssignment(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @Param({ schema: IdParams }) { id }: IdParams,
    @Body({ schema: UpdateAssignmentDto }) dto: UpdateAssignmentDto,
  ) {
    const assignment = await this.manageAssignmentUseCase.updateAssignment(
      ctx,
      id,
      {
        ...dto,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
        status: dto.status || undefined,
      },
    );

    return assignment;
  }

  @Patch('assignments/:id/status')
  @Permissions('scouting.assignment.update')
  @ApiOperation({ summary: 'Update assignment status' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Status updated successfully',
  })
  async updateAssignmentStatus(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @CurrentUser() member: SessionMember,
    @Param({ schema: IdParams }) { id }: IdParams,
    @Body({ schema: AssignmentStatusDto }) { status }: AssignmentStatusDto,
  ) {
    const assignment = await this.manageAssignmentUseCase.updateStatus(
      ctx,
      id,
      status,
      member.role,
    );

    return assignment;
  }

  @Delete('assignments/:id')
  @Permissions('scouting.assignment.manage')
  @ApiOperation({ summary: 'Delete assignment' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Assignment deleted successfully',
  })
  async deleteAssignment(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @Param({ schema: IdParams }) { id }: IdParams,
  ) {
    await this.manageAssignmentUseCase.deleteAssignment(ctx, id);
  }
}
