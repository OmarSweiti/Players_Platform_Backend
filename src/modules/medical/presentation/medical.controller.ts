import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Delete,
  Patch,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { Permissions } from '../../../common/decorators/permissions.decorator';
import { PERMISSIONS } from '../../../shared/constants/permissions.constants';
import { CreateMedicalRecordDto } from './dto/create-medical-record.dto';
import { UpdateMedicalRecordDto } from './dto/update-medical-record.dto';
import { CreateTreatmentSessionDto } from './dto/create-treatment-session.dto';
import { UpdateTreatmentSessionDto } from './dto/update-treatment-session.dto';
import { CreateMedicalRecordUseCase } from '../application/use-cases/create-medical-record.use-case';
import { UpdateMedicalRecordUseCase } from '../application/use-cases/update-medical-record.use-case';
import { CreateTreatmentSessionUseCase } from '../application/use-cases/create-treatment-session.use-case';
import { UpdateTreatmentSessionUseCase } from '../application/use-cases/update-treatment-session.use-case';
import { MedicalRecordRepository } from '../infrastructure/repositories/medical-record.repository';
import { TreatmentSessionRepository } from '../infrastructure/repositories/treatment-session.repository';

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
  async createRecord(@CurrentUser() user: any, @Body() dto: CreateMedicalRecordDto) {
    const record = await this.createMedicalRecordUseCase.execute({
      ...dto,
      createdById: user.id,
      tenantId: user.tenantId,
      injuryDate: dto.injuryDate ? new Date(dto.injuryDate) : undefined,
      recoveryDate: dto.recoveryDate ? new Date(dto.recoveryDate) : undefined,
      returnToPlayDate: dto.returnToPlayDate ? new Date(dto.returnToPlayDate) : undefined,
    });

    return {
      statusCode: HttpStatus.CREATED,
      message: 'Medical record created successfully',
      data: record,
    };
  }

  @Get('records')
  @Permissions(PERMISSIONS.MEDICAL_READ)
  @ApiOperation({ summary: 'Get all medical records' })
  async getRecords(@CurrentUser() user: any, @Query() query: any) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const filters = {
      playerId: query.playerId,
      injuryType: query.injuryType,
      isConfidential: query.isConfidential === 'true' ? true : query.isConfidential === 'false' ? false : undefined,
    };

    const { records, total } = await this.medicalRecordRepo.findAll(
      user.tenantId,
      filters,
      { skip, take: limit },
    );

    return {
      statusCode: HttpStatus.OK,
      data: records,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  @Get('records/player/:playerId')
  @Permissions(PERMISSIONS.MEDICAL_READ)
  @ApiOperation({ summary: 'Get medical records for a player' })
  async getPlayerRecords(@CurrentUser() user: any, @Param('playerId') playerId: string, @Query() query: any) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const filters = {
      injuryType: query.injuryType,
      isConfidential: query.isConfidential === 'true' ? true : query.isConfidential === 'false' ? false : undefined,
    };

    const { records, total } = await this.medicalRecordRepo.findByPlayer(
      playerId,
      user.tenantId,
      filters,
      { skip, take: limit },
    );

    return {
      statusCode: HttpStatus.OK,
      data: records,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  @Get('records/:id')
  @Permissions(PERMISSIONS.MEDICAL_READ)
  @ApiOperation({ summary: 'Get medical record by ID' })
  async getRecord(@CurrentUser() user: any, @Param('id') id: string) {
    const record = await this.medicalRecordRepo.findById(id, user.tenantId);
    
    if (!record) {
      return { statusCode: HttpStatus.NOT_FOUND, message: 'Medical record not found' };
    }

    return { statusCode: HttpStatus.OK, data: record };
  }

  @Patch('records/:id')
  @Permissions(PERMISSIONS.MEDICAL_UPDATE)
  @ApiOperation({ summary: 'Update medical record' })
  async updateRecord(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: UpdateMedicalRecordDto,
  ) {
    const record = await this.updateMedicalRecordUseCase.execute(
      id,
      user.tenantId,
      {
        ...dto,
        injuryDate: dto.injuryDate ? new Date(dto.injuryDate) : undefined,
        recoveryDate: dto.recoveryDate ? new Date(dto.recoveryDate) : undefined,
        returnToPlayDate: dto.returnToPlayDate ? new Date(dto.returnToPlayDate) : undefined,
      },
      user.id,
      user.role,
    );

    return {
      statusCode: HttpStatus.OK,
      message: 'Medical record updated successfully',
      data: record,
    };
  }

  @Delete('records/:id')
  @Permissions(PERMISSIONS.MEDICAL_UPDATE)
  @ApiOperation({ summary: 'Delete medical record' })
  async deleteRecord(@CurrentUser() user: any, @Param('id') id: string) {
    await this.medicalRecordRepo.softDelete(id, user.tenantId);

    return { statusCode: HttpStatus.OK, message: 'Medical record deleted successfully' };
  }

  @Get('records/player/:playerId/active-injuries')
  @Permissions(PERMISSIONS.MEDICAL_READ)
  @ApiOperation({ summary: 'Get active injuries for a player' })
  async getActiveInjuries(@CurrentUser() user: any, @Param('playerId') playerId: string) {
    const injuries = await this.medicalRecordRepo.getActiveInjuries(playerId, user.tenantId);

    return { statusCode: HttpStatus.OK, data: injuries };
  }

  @Get('records/player/:playerId/history')
  @Permissions(PERMISSIONS.MEDICAL_READ)
  @ApiOperation({ summary: 'Get player injury history statistics' })
  async getInjuryHistory(@CurrentUser() user: any, @Param('playerId') playerId: string) {
    const stats = await this.medicalRecordRepo.getPlayerInjuryHistory(playerId, user.tenantId);

    return { statusCode: HttpStatus.OK, data: stats };
  }

  // ==================== TREATMENT SESSIONS ====================

  @Post('sessions')
  @Permissions(PERMISSIONS.MEDICAL_CREATE)
  @ApiOperation({ summary: 'Create treatment session' })
  async createSession(@CurrentUser() user: any, @Body() dto: CreateTreatmentSessionDto) {
    const session = await this.createTreatmentSessionUseCase.execute({
      ...dto,
      conductedBy: user.id,
      tenantId: user.tenantId,
      sessionDate: new Date(dto.sessionDate),
      status: dto.status ? (dto.status as any) : undefined,
    });

    return {
      statusCode: HttpStatus.CREATED,
      message: 'Treatment session created successfully',
      data: session,
    };
  }

  @Get('sessions/player/:playerId')
  @Permissions(PERMISSIONS.MEDICAL_READ)
  @ApiOperation({ summary: 'Get treatment sessions for a player' })
  async getPlayerSessions(@CurrentUser() user: any, @Param('playerId') playerId: string, @Query() query: any) {
    const page = query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    const filters = {
      status: query.status as any,
      medicalRecordId: query.medicalRecordId,
      dateFrom: query.dateFrom ? new Date(query.dateFrom) : undefined,
      dateTo: query.dateTo ? new Date(query.dateTo) : undefined,
    };

    const { sessions, total } = await this.treatmentSessionRepo.findByPlayer(
      playerId,
      user.tenantId,
      filters,
      { skip, take: limit },
    );

    return {
      statusCode: HttpStatus.OK,
      data: sessions,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  @Get('sessions/:id')
  @Permissions(PERMISSIONS.MEDICAL_READ)
  @ApiOperation({ summary: 'Get treatment session by ID' })
  async getSession(@CurrentUser() user: any, @Param('id') id: string) {
    const session = await this.treatmentSessionRepo.findById(id, user.tenantId);
    
    if (!session) {
      return { statusCode: HttpStatus.NOT_FOUND, message: 'Treatment session not found' };
    }

    return { statusCode: HttpStatus.OK, data: session };
  }

  @Patch('sessions/:id')
  @Permissions(PERMISSIONS.MEDICAL_UPDATE)
  @ApiOperation({ summary: 'Update treatment session' })
  async updateSession(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: UpdateTreatmentSessionDto,
  ) {
    const session = await this.updateTreatmentSessionUseCase.execute(
      id,
      user.tenantId,
      {
        ...dto,
        sessionDate: dto.sessionDate ? new Date(dto.sessionDate) : undefined,
        status: dto.status ? (dto.status as any) : undefined,
      },
      user.id,
      user.role,
    );

    return {
      statusCode: HttpStatus.OK,
      message: 'Treatment session updated successfully',
      data: session,
    };
  }

  @Patch('sessions/:id/status')
  @Permissions(PERMISSIONS.MEDICAL_UPDATE)
  @ApiOperation({ summary: 'Update treatment session status' })
  async updateSessionStatus(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body('status') status: string,
  ) {
    const session = await this.treatmentSessionRepo.updateStatus(id, user.tenantId, status as any);

    return {
      statusCode: HttpStatus.OK,
      message: 'Session status updated successfully',
      data: session,
    };
  }

  @Delete('sessions/:id')
  @Permissions(PERMISSIONS.MEDICAL_UPDATE)
  @ApiOperation({ summary: 'Delete treatment session' })
  async deleteSession(@CurrentUser() user: any, @Param('id') id: string) {
    await this.treatmentSessionRepo.delete(id, user.tenantId);

    return { statusCode: HttpStatus.OK, message: 'Treatment session deleted successfully' };
  }

  @Get('sessions/player/:playerId/upcoming')
  @Permissions(PERMISSIONS.MEDICAL_READ)
  @ApiOperation({ summary: 'Get upcoming treatment sessions' })
  async getUpcomingSessions(@CurrentUser() user: any, @Param('playerId') playerId: string) {
    const sessions = await this.treatmentSessionRepo.getUpcomingSessions(playerId, user.tenantId);

    return { statusCode: HttpStatus.OK, data: sessions };
  }

  @Get('sessions/player/:playerId/stats')
  @Permissions(PERMISSIONS.MEDICAL_READ)
  @ApiOperation({ summary: 'Get treatment session statistics' })
  async getSessionStats(@CurrentUser() user: any, @Param('playerId') playerId: string) {
    const stats = await this.treatmentSessionRepo.getSessionStats(playerId, user.tenantId);

    return { statusCode: HttpStatus.OK, data: stats };
  }
}
