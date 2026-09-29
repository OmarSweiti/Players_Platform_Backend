import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../infrastructure/prisma/prisma.service';
import { MedicalRecord } from '@prisma/client';

export interface CreateMedicalRecordInput {
  playerId: string;
  tenantId: string;
  createdById: string;
  injuryType: string;
  bodyPart?: string;
  severity?: string;
  description?: string;
  treatment?: string;
  injuryDate?: Date;
  recoveryDate?: Date;
  returnToPlayDate?: Date;
  isConfidential?: boolean;
  metadata?: any;
}

export interface UpdateMedicalRecordInput {
  injuryType?: string;
  bodyPart?: string;
  severity?: string;
  description?: string;
  treatment?: string;
  injuryDate?: Date;
  recoveryDate?: Date;
  returnToPlayDate?: Date;
  isConfidential?: boolean;
  metadata?: any;
}

@Injectable()
export class MedicalRecordRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: CreateMedicalRecordInput): Promise<MedicalRecord> {
    return this.prisma.medicalRecord.create({
      data: {
        ...data,
        isConfidential: data.isConfidential ?? true,
      },
      include: {
        player: {
          select: {
            id: true,
            fullName: true,
            position: true,
          },
        },
        createdBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            role: true,
          },
        },
      },
    });
  }

  async findById(id: string, tenantId: string): Promise<MedicalRecord | null> {
    return this.prisma.medicalRecord.findUnique({
      where: {
        id_tenantId: {
          id,
          tenantId,
        },
        deletedAt: null,
      },
      include: {
        player: {
          select: {
            id: true,
            fullName: true,
            position: true,
          },
        },
        createdBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            role: true,
          },
        },
      },
    });
  }

  async findByPlayer(
    playerId: string,
    tenantId: string,
    filters?: {
      injuryType?: string;
      isConfidential?: boolean;
      dateFrom?: Date;
      dateTo?: Date;
    },
    pagination?: { skip?: number; take?: number },
  ): Promise<{ records: MedicalRecord[]; total: number }> {
    const where: any = {
      playerId,
      tenantId,
      deletedAt: null,
    };

    if (filters?.injuryType) where.injuryType = filters.injuryType;
    if (filters?.isConfidential !== undefined)
      where.isConfidential = filters.isConfidential;
    if (filters?.dateFrom || filters?.dateTo) {
      where.injuryDate = {};
      if (filters.dateFrom) where.injuryDate.gte = filters.dateFrom;
      if (filters.dateTo) where.injuryDate.lte = filters.dateTo;
    }

    const [records, total] = await Promise.all([
      this.prisma.medicalRecord.findMany({
        where,
        include: {
          createdBy: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              role: true,
            },
          },
        },
        orderBy: { injuryDate: 'desc' },
        skip: pagination?.skip,
        take: pagination?.take,
      }),
      this.prisma.medicalRecord.count({ where }),
    ]);

    return { records, total };
  }

  async findAll(
    tenantId: string,
    filters?: {
      playerId?: string;
      injuryType?: string;
      isConfidential?: boolean;
    },
    pagination?: { skip?: number; take?: number },
  ): Promise<{ records: MedicalRecord[]; total: number }> {
    const where: any = {
      tenantId,
      deletedAt: null,
    };

    if (filters?.playerId) where.playerId = filters.playerId;
    if (filters?.injuryType) where.injuryType = filters.injuryType;
    if (filters?.isConfidential !== undefined)
      where.isConfidential = filters.isConfidential;

    const [records, total] = await Promise.all([
      this.prisma.medicalRecord.findMany({
        where,
        include: {
          player: {
            select: {
              id: true,
              fullName: true,
              position: true,
            },
          },
          createdBy: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              role: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: pagination?.skip,
        take: pagination?.take,
      }),
      this.prisma.medicalRecord.count({ where }),
    ]);

    return { records, total };
  }

  async update(
    id: string,
    tenantId: string,
    data: UpdateMedicalRecordInput,
  ): Promise<MedicalRecord> {
    return this.prisma.medicalRecord.update({
      where: {
        id_tenantId: {
          id,
          tenantId,
        },
      },
      data,
    });
  }

  async softDelete(id: string, tenantId: string): Promise<MedicalRecord> {
    return this.prisma.medicalRecord.update({
      where: {
        id_tenantId: {
          id,
          tenantId,
        },
      },
      data: {
        deletedAt: new Date(),
      },
    });
  }

  async getActiveInjuries(
    playerId: string,
    tenantId: string,
  ): Promise<MedicalRecord[]> {
    return this.prisma.medicalRecord.findMany({
      where: {
        playerId,
        tenantId,
        deletedAt: null,
        recoveryDate: null, // Not yet recovered
      },
      orderBy: { injuryDate: 'desc' },
    });
  }

  async getPlayerInjuryHistory(
    playerId: string,
    tenantId: string,
  ): Promise<any> {
    const [total, byType, bySeverity] = await Promise.all([
      this.prisma.medicalRecord.count({
        where: { playerId, tenantId, deletedAt: null },
      }),
      this.prisma.medicalRecord.groupBy({
        by: ['injuryType'],
        where: { playerId, tenantId, deletedAt: null },
        _count: true,
      }),
      this.prisma.medicalRecord.groupBy({
        by: ['severity'],
        where: { playerId, tenantId, deletedAt: null },
        _count: true,
      }),
    ]);

    return { total, byType, bySeverity };
  }
}
