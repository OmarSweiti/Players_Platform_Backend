import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Delete,
  Patch,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import type { SessionMember } from '../../../common/interfaces/request-with-user.interface';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { CurrentTenantContext } from '../../../common/decorators/tenant-context.decorator';
import type { AuthorizedTenantContext } from '../../../common/tenancy/tenant-context';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { CreateMedicalRecordDto } from './dto/create-medical-record.dto';
import { UpdateMedicalRecordDto } from './dto/update-medical-record.dto';
import { CreateTreatmentSessionDto } from './dto/create-treatment-session.dto';
import { UpdateTreatmentSessionDto } from './dto/update-treatment-session.dto';
import {
  MedicalRecordsQuery,
  PlayerMedicalRecordsQuery,
  PlayerTreatmentSessionsQuery,
} from './dto/medical-queries.dto';
import { TreatmentSessionStatusDto } from './dto/update-treatment-session.dto';
import { IdParams, PlayerIdParams } from '../../../common/validation/schemas';
import { CreateMedicalRecordUseCase } from '../application/use-cases/create-medical-record.usecase';
import { UpdateMedicalRecordUseCase } from '../application/use-cases/update-medical-record.usecase';
import { CreateTreatmentSessionUseCase } from '../application/use-cases/create-treatment-session.usecase';
import { UpdateTreatmentSessionUseCase } from '../application/use-cases/update-treatment-session.usecase';
import { ReadMedicalRecordsUseCase } from '../application/use-cases/read-medical-records.usecase';
import { ArchiveMedicalRecordUseCase } from '../application/use-cases/archive-medical-record.usecase';
import { ReadTreatmentSessionsUseCase } from '../application/use-cases/read-treatment-sessions.usecase';
import { ChangeTreatmentSessionUseCase } from '../application/use-cases/change-treatment-session.usecase';

@ApiTags('Medical')
@ApiBearerAuth()
@Controller('medical')
export class MedicalController {
  constructor(
    private readonly createMedicalRecordUseCase: CreateMedicalRecordUseCase,
    private readonly updateMedicalRecordUseCase: UpdateMedicalRecordUseCase,
    private readonly createTreatmentSessionUseCase: CreateTreatmentSessionUseCase,
    private readonly updateTreatmentSessionUseCase: UpdateTreatmentSessionUseCase,
    private readonly readMedicalRecords: ReadMedicalRecordsUseCase,
    private readonly archiveMedicalRecord: ArchiveMedicalRecordUseCase,
    private readonly readTreatmentSessions: ReadTreatmentSessionsUseCase,
    private readonly changeTreatmentSession: ChangeTreatmentSessionUseCase,
  ) {}

  // ==================== MEDICAL RECORDS ====================

  @Post('records')
  @Permissions('medical.create')
  @ApiOperation({ summary: 'Create medical record' })
  async createRecord(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @Body({ schema: CreateMedicalRecordDto }) dto: CreateMedicalRecordDto,
  ) {
    const record = await this.createMedicalRecordUseCase.execute(ctx, {
      ...dto,
      injuryDate: dto.injuryDate ? new Date(dto.injuryDate) : undefined,
      recoveryDate: dto.recoveryDate ? new Date(dto.recoveryDate) : undefined,
      returnToPlayDate: dto.returnToPlayDate
        ? new Date(dto.returnToPlayDate)
        : undefined,
    });

    return record;
  }

  @Get('records')
  @Permissions('medical.read')
  @ApiOperation({ summary: 'Get all medical records' })
  async getRecords(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @Query({ schema: MedicalRecordsQuery }) query: MedicalRecordsQuery,
  ) {
    const { page, limit } = query;
    const skip = (page - 1) * limit;

    const filters = {
      playerId: query.playerId,
      injuryType: query.injuryType,
      isConfidential: query.isConfidential,
    };

    return this.readMedicalRecords.list(ctx, filters, { skip, take: limit });
  }

  @Get('records/player/:playerId')
  @Permissions('medical.read')
  @ApiOperation({ summary: 'Get medical records for a player' })
  async getPlayerRecords(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @Param({ schema: PlayerIdParams }) { playerId }: PlayerIdParams,
    @Query({ schema: PlayerMedicalRecordsQuery })
    query: PlayerMedicalRecordsQuery,
  ) {
    const { page, limit } = query;
    const skip = (page - 1) * limit;

    const filters = {
      injuryType: query.injuryType,
      isConfidential: query.isConfidential,
    };

    return this.readMedicalRecords.forPlayer(ctx, playerId, filters, {
      skip,
      take: limit,
    });
  }

  @Get('records/:id')
  @Permissions('medical.read')
  @ApiOperation({ summary: 'Get medical record by ID' })
  async getRecord(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @Param({ schema: IdParams }) { id }: IdParams,
  ) {
    return this.readMedicalRecords.get(ctx, id);
  }

  @Patch('records/:id')
  @Permissions('medical.update')
  @ApiOperation({ summary: 'Update medical record' })
  async updateRecord(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @CurrentUser() member: SessionMember,
    @Param({ schema: IdParams }) { id }: IdParams,
    @Body({ schema: UpdateMedicalRecordDto }) dto: UpdateMedicalRecordDto,
  ) {
    const record = await this.updateMedicalRecordUseCase.execute(
      ctx,
      id,
      {
        ...dto,
        injuryDate: dto.injuryDate ? new Date(dto.injuryDate) : undefined,
        recoveryDate: dto.recoveryDate ? new Date(dto.recoveryDate) : undefined,
        returnToPlayDate: dto.returnToPlayDate
          ? new Date(dto.returnToPlayDate)
          : undefined,
      },
      member.role,
    );

    return record;
  }

  @Delete('records/:id')
  @Permissions('medical.update')
  @ApiOperation({ summary: 'Delete medical record' })
  async deleteRecord(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @Param({ schema: IdParams }) { id }: IdParams,
  ) {
    await this.archiveMedicalRecord.execute(ctx, id);
  }

  @Get('records/player/:playerId/active-injuries')
  @Permissions('medical.read')
  @ApiOperation({ summary: 'Get active injuries for a player' })
  async getActiveInjuries(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @Param({ schema: PlayerIdParams }) { playerId }: PlayerIdParams,
  ) {
    return this.readMedicalRecords.activeInjuries(ctx, playerId);
  }

  @Get('records/player/:playerId/history')
  @Permissions('medical.read')
  @ApiOperation({ summary: 'Get player injury history statistics' })
  async getInjuryHistory(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @Param({ schema: PlayerIdParams }) { playerId }: PlayerIdParams,
  ): Promise<unknown> {
    return this.readMedicalRecords.injuryHistory(ctx, playerId);
  }

  // ==================== TREATMENT SESSIONS ====================

  @Post('sessions')
  @Permissions('medical.create')
  @ApiOperation({ summary: 'Create treatment session' })
  async createSession(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @Body({ schema: CreateTreatmentSessionDto }) dto: CreateTreatmentSessionDto,
  ) {
    const session = await this.createTreatmentSessionUseCase.execute(ctx, {
      ...dto,
      sessionDate: new Date(dto.sessionDate),
      status: dto.status,
    });

    return session;
  }

  @Get('sessions/player/:playerId')
  @Permissions('medical.read')
  @ApiOperation({ summary: 'Get treatment sessions for a player' })
  async getPlayerSessions(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @Param({ schema: PlayerIdParams }) { playerId }: PlayerIdParams,
    @Query({ schema: PlayerTreatmentSessionsQuery })
    query: PlayerTreatmentSessionsQuery,
  ) {
    const { page, limit } = query;
    const skip = (page - 1) * limit;

    const filters = {
      status: query.status,
      medicalRecordId: query.medicalRecordId,
      dateFrom: query.dateFrom ? new Date(query.dateFrom) : undefined,
      dateTo: query.dateTo ? new Date(query.dateTo) : undefined,
    };

    return this.readTreatmentSessions.forPlayer(ctx, playerId, filters, {
      skip,
      take: limit,
    });
  }

  @Get('sessions/:id')
  @Permissions('medical.read')
  @ApiOperation({ summary: 'Get treatment session by ID' })
  async getSession(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @Param({ schema: IdParams }) { id }: IdParams,
  ) {
    return this.readTreatmentSessions.get(ctx, id);
  }

  @Patch('sessions/:id')
  @Permissions('medical.update')
  @ApiOperation({ summary: 'Update treatment session' })
  async updateSession(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @CurrentUser() member: SessionMember,
    @Param({ schema: IdParams }) { id }: IdParams,
    @Body({ schema: UpdateTreatmentSessionDto }) dto: UpdateTreatmentSessionDto,
  ) {
    const session = await this.updateTreatmentSessionUseCase.execute(
      ctx,
      id,
      {
        ...dto,
        sessionDate: dto.sessionDate ? new Date(dto.sessionDate) : undefined,
        status: dto.status,
      },
      member.role,
    );

    return session;
  }

  @Patch('sessions/:id/status')
  @Permissions('medical.update')
  @ApiOperation({ summary: 'Update treatment session status' })
  async updateSessionStatus(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @Param({ schema: IdParams }) { id }: IdParams,
    @Body({ schema: TreatmentSessionStatusDto })
    { status }: TreatmentSessionStatusDto,
  ) {
    return this.changeTreatmentSession.setStatus(ctx, id, status);
  }

  @Delete('sessions/:id')
  @Permissions('medical.update')
  @ApiOperation({ summary: 'Delete treatment session' })
  async deleteSession(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @Param({ schema: IdParams }) { id }: IdParams,
  ) {
    await this.changeTreatmentSession.delete(ctx, id);
  }

  @Get('sessions/player/:playerId/upcoming')
  @Permissions('medical.read')
  @ApiOperation({ summary: 'Get upcoming treatment sessions' })
  async getUpcomingSessions(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @Param({ schema: PlayerIdParams }) { playerId }: PlayerIdParams,
  ) {
    return this.readTreatmentSessions.upcoming(ctx, playerId);
  }

  @Get('sessions/player/:playerId/stats')
  @Permissions('medical.read')
  @ApiOperation({ summary: 'Get treatment session statistics' })
  async getSessionStats(
    @CurrentTenantContext() ctx: AuthorizedTenantContext,
    @Param({ schema: PlayerIdParams }) { playerId }: PlayerIdParams,
  ): Promise<unknown> {
    return this.readTreatmentSessions.stats(ctx, playerId);
  }
}
