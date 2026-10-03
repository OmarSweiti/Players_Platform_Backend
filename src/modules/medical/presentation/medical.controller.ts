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
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { PERMISSIONS } from '../../../shared/constants/permissions.constants';
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
import { MedicalRecordRepository } from '../infrastructure/repositories/medical-record.repository';
import { TreatmentSessionRepository } from '../infrastructure/repositories/treatment-session.repository';
import { NotFoundError } from '../../../common/errors/domain-error';

@ApiTags('Medical')
@ApiBearerAuth()
@Controller('medical')
export class MedicalController {
  constructor(
    private readonly createMedicalRecordUseCase: CreateMedicalRecordUseCase,
    private readonly updateMedicalRecordUseCase: UpdateMedicalRecordUseCase,
    private readonly createTreatmentSessionUseCase: CreateTreatmentSessionUseCase,
    private readonly updateTreatmentSessionUseCase: UpdateTreatmentSessionUseCase,
    private readonly medicalRecordRepo: MedicalRecordRepository,
    private readonly treatmentSessionRepo: TreatmentSessionRepository,
  ) {}

  // ==================== MEDICAL RECORDS ====================

  @Post('records')
  @Permissions(PERMISSIONS.MEDICAL_CREATE)
  @ApiOperation({ summary: 'Create medical record' })
  async createRecord(
    @CurrentUser() user: any,
    @Body({ schema: CreateMedicalRecordDto }) dto: CreateMedicalRecordDto,
  ) {
    const record = await this.createMedicalRecordUseCase.execute({
      ...dto,
      createdById: user.id,
      tenantId: user.tenantId,
      injuryDate: dto.injuryDate ? new Date(dto.injuryDate) : undefined,
      recoveryDate: dto.recoveryDate ? new Date(dto.recoveryDate) : undefined,
      returnToPlayDate: dto.returnToPlayDate
        ? new Date(dto.returnToPlayDate)
        : undefined,
    });

    return record;
  }

  @Get('records')
  @Permissions(PERMISSIONS.MEDICAL_READ)
  @ApiOperation({ summary: 'Get all medical records' })
  async getRecords(
    @CurrentUser() user: any,
    @Query({ schema: MedicalRecordsQuery }) query: MedicalRecordsQuery,
  ) {
    const { page, limit } = query;
    const skip = (page - 1) * limit;

    const filters = {
      playerId: query.playerId,
      injuryType: query.injuryType,
      isConfidential: query.isConfidential,
    };

    const { records } = await this.medicalRecordRepo.findAll(
      user.tenantId,
      filters,
      { skip, take: limit },
    );

    return records;
  }

  @Get('records/player/:playerId')
  @Permissions(PERMISSIONS.MEDICAL_READ)
  @ApiOperation({ summary: 'Get medical records for a player' })
  async getPlayerRecords(
    @CurrentUser() user: any,
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

    const { records } = await this.medicalRecordRepo.findByPlayer(
      playerId,
      user.tenantId,
      filters,
      { skip, take: limit },
    );

    return records;
  }

  @Get('records/:id')
  @Permissions(PERMISSIONS.MEDICAL_READ)
  @ApiOperation({ summary: 'Get medical record by ID' })
  async getRecord(
    @CurrentUser() user: any,
    @Param({ schema: IdParams }) { id }: IdParams,
  ) {
    const record = await this.medicalRecordRepo.findById(id, user.tenantId);

    if (!record) {
      throw new NotFoundError('Medical record not found');
    }

    return record;
  }

  @Patch('records/:id')
  @Permissions(PERMISSIONS.MEDICAL_UPDATE)
  @ApiOperation({ summary: 'Update medical record' })
  async updateRecord(
    @CurrentUser() user: any,
    @Param({ schema: IdParams }) { id }: IdParams,
    @Body({ schema: UpdateMedicalRecordDto }) dto: UpdateMedicalRecordDto,
  ) {
    const record = await this.updateMedicalRecordUseCase.execute(
      id,
      user.tenantId,
      {
        ...dto,
        injuryDate: dto.injuryDate ? new Date(dto.injuryDate) : undefined,
        recoveryDate: dto.recoveryDate ? new Date(dto.recoveryDate) : undefined,
        returnToPlayDate: dto.returnToPlayDate
          ? new Date(dto.returnToPlayDate)
          : undefined,
      },
      user.id,
      user.role,
    );

    return record;
  }

  @Delete('records/:id')
  @Permissions(PERMISSIONS.MEDICAL_UPDATE)
  @ApiOperation({ summary: 'Delete medical record' })
  async deleteRecord(
    @CurrentUser() user: any,
    @Param({ schema: IdParams }) { id }: IdParams,
  ) {
    await this.medicalRecordRepo.softDelete(id, user.tenantId);
  }

  @Get('records/player/:playerId/active-injuries')
  @Permissions(PERMISSIONS.MEDICAL_READ)
  @ApiOperation({ summary: 'Get active injuries for a player' })
  async getActiveInjuries(
    @CurrentUser() user: any,
    @Param({ schema: PlayerIdParams }) { playerId }: PlayerIdParams,
  ) {
    const injuries = await this.medicalRecordRepo.getActiveInjuries(
      playerId,
      user.tenantId,
    );

    return injuries;
  }

  @Get('records/player/:playerId/history')
  @Permissions(PERMISSIONS.MEDICAL_READ)
  @ApiOperation({ summary: 'Get player injury history statistics' })
  async getInjuryHistory(
    @CurrentUser() user: any,
    @Param({ schema: PlayerIdParams }) { playerId }: PlayerIdParams,
  ): Promise<unknown> {
    const stats = await this.medicalRecordRepo.getPlayerInjuryHistory(
      playerId,
      user.tenantId,
    );

    return stats;
  }

  // ==================== TREATMENT SESSIONS ====================

  @Post('sessions')
  @Permissions(PERMISSIONS.MEDICAL_CREATE)
  @ApiOperation({ summary: 'Create treatment session' })
  async createSession(
    @CurrentUser() user: any,
    @Body({ schema: CreateTreatmentSessionDto }) dto: CreateTreatmentSessionDto,
  ) {
    const session = await this.createTreatmentSessionUseCase.execute({
      ...dto,
      conductedBy: user.id,
      tenantId: user.tenantId,
      sessionDate: new Date(dto.sessionDate),
      status: dto.status,
    });

    return session;
  }

  @Get('sessions/player/:playerId')
  @Permissions(PERMISSIONS.MEDICAL_READ)
  @ApiOperation({ summary: 'Get treatment sessions for a player' })
  async getPlayerSessions(
    @CurrentUser() user: any,
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

    const { sessions } = await this.treatmentSessionRepo.findByPlayer(
      playerId,
      user.tenantId,
      filters,
      { skip, take: limit },
    );

    return sessions;
  }

  @Get('sessions/:id')
  @Permissions(PERMISSIONS.MEDICAL_READ)
  @ApiOperation({ summary: 'Get treatment session by ID' })
  async getSession(
    @CurrentUser() user: any,
    @Param({ schema: IdParams }) { id }: IdParams,
  ) {
    const session = await this.treatmentSessionRepo.findById(id, user.tenantId);

    if (!session) {
      throw new NotFoundError('Treatment session not found');
    }

    return session;
  }

  @Patch('sessions/:id')
  @Permissions(PERMISSIONS.MEDICAL_UPDATE)
  @ApiOperation({ summary: 'Update treatment session' })
  async updateSession(
    @CurrentUser() user: any,
    @Param({ schema: IdParams }) { id }: IdParams,
    @Body({ schema: UpdateTreatmentSessionDto }) dto: UpdateTreatmentSessionDto,
  ) {
    const session = await this.updateTreatmentSessionUseCase.execute(
      id,
      user.tenantId,
      {
        ...dto,
        sessionDate: dto.sessionDate ? new Date(dto.sessionDate) : undefined,
        status: dto.status,
      },
      user.id,
      user.role,
    );

    return session;
  }

  @Patch('sessions/:id/status')
  @Permissions(PERMISSIONS.MEDICAL_UPDATE)
  @ApiOperation({ summary: 'Update treatment session status' })
  async updateSessionStatus(
    @CurrentUser() user: any,
    @Param({ schema: IdParams }) { id }: IdParams,
    @Body({ schema: TreatmentSessionStatusDto })
    { status }: TreatmentSessionStatusDto,
  ) {
    const session = await this.treatmentSessionRepo.updateStatus(
      id,
      user.tenantId,
      status,
    );

    return session;
  }

  @Delete('sessions/:id')
  @Permissions(PERMISSIONS.MEDICAL_UPDATE)
  @ApiOperation({ summary: 'Delete treatment session' })
  async deleteSession(
    @CurrentUser() user: any,
    @Param({ schema: IdParams }) { id }: IdParams,
  ) {
    await this.treatmentSessionRepo.delete(id, user.tenantId);
  }

  @Get('sessions/player/:playerId/upcoming')
  @Permissions(PERMISSIONS.MEDICAL_READ)
  @ApiOperation({ summary: 'Get upcoming treatment sessions' })
  async getUpcomingSessions(
    @CurrentUser() user: any,
    @Param({ schema: PlayerIdParams }) { playerId }: PlayerIdParams,
  ) {
    const sessions = await this.treatmentSessionRepo.getUpcomingSessions(
      playerId,
      user.tenantId,
    );

    return sessions;
  }

  @Get('sessions/player/:playerId/stats')
  @Permissions(PERMISSIONS.MEDICAL_READ)
  @ApiOperation({ summary: 'Get treatment session statistics' })
  async getSessionStats(
    @CurrentUser() user: any,
    @Param({ schema: PlayerIdParams }) { playerId }: PlayerIdParams,
  ): Promise<unknown> {
    const stats = await this.treatmentSessionRepo.getSessionStats(
      playerId,
      user.tenantId,
    );

    return stats;
  }
}
