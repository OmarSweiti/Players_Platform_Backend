import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../infrastructure/prisma/prisma.service';
import { ScoutingReport, ScoutReportStatus } from '@prisma/client';

export interface CreateScoutingReportInput {
  scoutId: string;
  tenantId: string;
  playerId?: string;
  prospectName?: string;
  prospectAge?: number;
  prospectClub?: string;
  prospectPosition?: any;
  prospectNationality?: string;
  recommendation?: any;
  technicalScore?: number;
  physicalScore?: number;
  tacticalScore?: number;
  mentalScore?: number;
  strengths?: string;
  weaknesses?: string;
  personalityNotes?: string;
  tacticalFit?: string;
  overallRating?: number;
  potentialRating?: number;
  matchObserved?: string;
  metadata?: any;
}

export interface UpdateScoutingReportInput {
  status?: ScoutReportStatus;
  recommendation?: any;
  technicalScore?: number;
  physicalScore?: number;
  tacticalScore?: number;
  mentalScore?: number;
  strengths?: string;
  weaknesses?: string;
  personalityNotes?: string;
  tacticalFit?: string;
  overallRating?: number;
  potentialRating?: number;
}

@Injectable()
export class ScoutingReportRepository {
  constructor(private prisma: PrismaService) {}

  async create(data: CreateScoutingReportInput): Promise<ScoutingReport> {
    return this.prisma.scoutingReport.create({
      data: {
        ...data,
        reportDate: new Date(),
        status: 'DRAFT',
      },
      include: {
        player: true,
        scout: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
    });
  }

  async findById(id: string, tenantId: string): Promise<ScoutingReport | null> {
    return this.prisma.scoutingReport.findUnique({
      where: {
        id_tenantId: {
          id,
          tenantId,
        },
        deletedAt: null,
      },
      include: {
        player: true,
        scout: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
    });
  }

  async findMany(
    tenantId: string,
    filters?: {
      status?: ScoutReportStatus;
      scoutId?: string;
      playerId?: string;
      recommendation?: any;
      dateFrom?: Date;
      dateTo?: Date;
    },
    pagination?: { skip?: number; take?: number },
  ): Promise<{ reports: ScoutingReport[]; total: number }> {
    const where: any = {
      tenantId,
      deletedAt: null,
    };

    if (filters?.status) where.status = filters.status;
    if (filters?.scoutId) where.scoutId = filters.scoutId;
    if (filters?.playerId) where.playerId = filters.playerId;
    if (filters?.recommendation) where.recommendation = filters.recommendation;
    if (filters?.dateFrom || filters?.dateTo) {
      where.reportDate = {};
      if (filters.dateFrom) where.reportDate.gte = filters.dateFrom;
      if (filters.dateTo) where.reportDate.lte = filters.dateTo;
    }

    const [reports, total] = await Promise.all([
      this.prisma.scoutingReport.findMany({
        where,
        include: {
          player: {
            select: {
              id: true,
              fullName: true,
              position: true,
            },
          },
          scout: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
            },
          },
        },
        orderBy: { reportDate: 'desc' },
        skip: pagination?.skip,
        take: pagination?.take,
      }),
      this.prisma.scoutingReport.count({ where }),
    ]);

    return { reports, total };
  }

  async update(
    id: string,
    tenantId: string,
    data: UpdateScoutingReportInput,
  ): Promise<ScoutingReport> {
    return this.prisma.scoutingReport.update({
      where: {
        id_tenantId: {
          id,
          tenantId,
        },
      },
      data,
      include: {
        player: true,
        scout: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    });
  }

  async softDelete(id: string, tenantId: string): Promise<ScoutingReport> {
    return this.prisma.scoutingReport.update({
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

  async submitReport(id: string, tenantId: string): Promise<ScoutingReport> {
    return this.prisma.scoutingReport.update({
      where: {
        id_tenantId: {
          id,
          tenantId,
        },
      },
      data: {
        status: 'SUBMITTED',
      },
    });
  }

  async approveReport(
    id: string,
    tenantId: string,
    recommendation: any,
  ): Promise<ScoutingReport> {
    return this.prisma.scoutingReport.update({
      where: {
        id_tenantId: {
          id,
          tenantId,
        },
      },
      data: {
        status: 'APPROVED',
        recommendation,
      },
    });
  }

  async rejectReport(id: string, tenantId: string): Promise<ScoutingReport> {
    return this.prisma.scoutingReport.update({
      where: {
        id_tenantId: {
          id,
          tenantId,
        },
      },
      data: {
        status: 'REJECTED',
      },
    });
  }

  async getStatsByScout(scoutId: string, tenantId: string): Promise<any> {
    const [total, draft, submitted, approved] = await Promise.all([
      this.prisma.scoutingReport.count({
        where: { scoutId, tenantId, deletedAt: null },
      }),
      this.prisma.scoutingReport.count({
        where: { scoutId, tenantId, status: 'DRAFT', deletedAt: null },
      }),
      this.prisma.scoutingReport.count({
        where: { scoutId, tenantId, status: 'SUBMITTED', deletedAt: null },
      }),
      this.prisma.scoutingReport.count({
        where: { scoutId, tenantId, status: 'APPROVED', deletedAt: null },
      }),
    ]);

    return { total, draft, submitted, approved };
  }
}
