import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../infrastructure/prisma/prisma.service';
import { TreatmentSession, TreatmentStatus } from '@prisma/client';

export interface CreateTreatmentSessionInput {
  playerId: string;
  tenantId: string;
  medicalRecordId?: string;
  sessionDate: Date;
  duration?: number;
  status?: TreatmentStatus;
  treatmentType: string;
  description?: string;
  exercises?: string;
  progressNotes?: string;
  conductedBy: string;
}

export interface UpdateTreatmentSessionInput {
  sessionDate?: Date;
  duration?: number;
  status?: TreatmentStatus;
  treatmentType?: string;
  description?: string;
  exercises?: string;
  progressNotes?: string;
}

@Injectable()
export class TreatmentSessionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: CreateTreatmentSessionInput): Promise<TreatmentSession> {
    return this.prisma.treatmentSession.create({
      data: {
        ...data,
        status: data.status || 'SCHEDULED',
      },
      include: {
        player: {
          select: {
            id: true,
            fullName: true,
            position: true,
          },
        },
        medicalRecord: {
          select: {
            id: true,
            injuryType: true,
            bodyPart: true,
          },
        },
        conductor: {
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

  async findById(
    id: string,
    tenantId: string,
  ): Promise<TreatmentSession | null> {
    return this.prisma.treatmentSession.findUnique({
      where: {
        id_tenantId: {
          id,
          tenantId,
        },
      },
      include: {
        player: {
          select: {
            id: true,
            fullName: true,
            position: true,
          },
        },
        medicalRecord: {
          select: {
            id: true,
            injuryType: true,
            bodyPart: true,
          },
        },
        conductor: {
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
      status?: TreatmentStatus;
      medicalRecordId?: string;
      dateFrom?: Date;
      dateTo?: Date;
    },
    pagination?: { skip?: number; take?: number },
  ): Promise<{ sessions: TreatmentSession[]; total: number }> {
    const where: any = {
      playerId,
      tenantId,
    };

    if (filters?.status) where.status = filters.status;
    if (filters?.medicalRecordId)
      where.medicalRecordId = filters.medicalRecordId;
    if (filters?.dateFrom || filters?.dateTo) {
      where.sessionDate = {};
      if (filters.dateFrom) where.sessionDate.gte = filters.dateFrom;
      if (filters.dateTo) where.sessionDate.lte = filters.dateTo;
    }

    const [sessions, total] = await Promise.all([
      this.prisma.treatmentSession.findMany({
        where,
        include: {
          conductor: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              role: true,
            },
          },
        },
        orderBy: { sessionDate: 'desc' },
        skip: pagination?.skip,
        take: pagination?.take,
      }),
      this.prisma.treatmentSession.count({ where }),
    ]);

    return { sessions, total };
  }

  async findByMedicalRecord(
    medicalRecordId: string,
    tenantId: string,
  ): Promise<TreatmentSession[]> {
    return this.prisma.treatmentSession.findMany({
      where: {
        medicalRecordId,
        tenantId,
      },
      include: {
        conductor: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            role: true,
          },
        },
      },
      orderBy: { sessionDate: 'asc' },
    });
  }

  async update(
    id: string,
    tenantId: string,
    data: UpdateTreatmentSessionInput,
  ): Promise<TreatmentSession> {
    return this.prisma.treatmentSession.update({
      where: {
        id_tenantId: {
          id,
          tenantId,
        },
      },
      data,
    });
  }

  async updateStatus(
    id: string,
    tenantId: string,
    status: TreatmentStatus,
  ): Promise<TreatmentSession> {
    return this.prisma.treatmentSession.update({
      where: {
        id_tenantId: {
          id,
          tenantId,
        },
      },
      data: { status },
    });
  }

  async delete(id: string, tenantId: string): Promise<TreatmentSession> {
    return this.prisma.treatmentSession.delete({
      where: {
        id_tenantId: {
          id,
          tenantId,
        },
      },
    });
  }

  async getUpcomingSessions(
    playerId: string,
    tenantId: string,
  ): Promise<TreatmentSession[]> {
    return this.prisma.treatmentSession.findMany({
      where: {
        playerId,
        tenantId,
        status: 'SCHEDULED',
        sessionDate: {
          gte: new Date(),
        },
      },
      orderBy: { sessionDate: 'asc' },
    });
  }

  async getSessionStats(playerId: string, tenantId: string): Promise<any> {
    const [total, scheduled, inProgress, completed] = await Promise.all([
      this.prisma.treatmentSession.count({
        where: { playerId, tenantId },
      }),
      this.prisma.treatmentSession.count({
        where: { playerId, tenantId, status: 'SCHEDULED' },
      }),
      this.prisma.treatmentSession.count({
        where: { playerId, tenantId, status: 'IN_PROGRESS' },
      }),
      this.prisma.treatmentSession.count({
        where: { playerId, tenantId, status: 'COMPLETED' },
      }),
    ]);

    return { total, scheduled, inProgress, completed };
  }
}
