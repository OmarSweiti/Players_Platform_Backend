import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../infrastructure/prisma/prisma.service';
import { ScoutingAssignment } from '@prisma/client';

export interface CreateScoutingAssignmentInput {
  assignedToId: string;
  assignedById: string;
  tenantId: string;
  region?: string;
  competition?: string;
  targetPosition?: string;
  minAge?: number;
  maxAge?: number;
  dueDate?: Date;
  notes?: string;
}

export interface UpdateScoutingAssignmentInput {
  region?: string;
  competition?: string;
  targetPosition?: string;
  minAge?: number;
  maxAge?: number;
  dueDate?: Date;
  status?: string;
  notes?: string;
}

@Injectable()
export class AssignmentRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create a new scouting assignment
   */
  async create(data: CreateScoutingAssignmentInput): Promise<ScoutingAssignment> {
    return this.prisma.scoutingAssignment.create({
      data: {
        ...data,
        status: 'OPEN',
        targetPosition: data.targetPosition ? (data.targetPosition as any) : undefined,
      },
      include: {
        assignedTo: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        assignedBy: {
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

  /**
   * Find assignment by ID
   */
  async findById(id: string, tenantId: string): Promise<ScoutingAssignment | null> {
    return this.prisma.scoutingAssignment.findUnique({
      where: {
        id_tenantId: {
          id,
          tenantId,
        },
      },
      include: {
        assignedTo: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        assignedBy: {
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

  /**
   * Get assignments for a specific scout
   */
  async getAssignmentsByScout(
    scoutId: string,
    tenantId: string,
    status?: string,
  ): Promise<ScoutingAssignment[]> {
    const where: any = {
      assignedToId: scoutId,
      tenantId,
    };

    if (status) {
      where.status = status;
    }

    return this.prisma.scoutingAssignment.findMany({
      where,
      include: {
        assignedBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Get assignments created by a sporting director
   */
  async getAssignmentsByDirector(
    directorId: string,
    tenantId: string,
    status?: string,
  ): Promise<ScoutingAssignment[]> {
    const where: any = {
      assignedById: directorId,
      tenantId,
    };

    if (status) {
      where.status = status;
    }

    return this.prisma.scoutingAssignment.findMany({
      where,
      include: {
        assignedTo: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Update assignment details
   */
  async update(
    id: string,
    tenantId: string,
    data: UpdateScoutingAssignmentInput,
  ): Promise<ScoutingAssignment> {
    return this.prisma.scoutingAssignment.update({
      where: {
        id_tenantId: {
          id,
          tenantId,
        },
      },
      data: {
        ...data,
        targetPosition: data.targetPosition ? (data.targetPosition as any) : undefined,
        status: data.status ? (data.status as any) : undefined,
      },
    });
  }

  /**
   * Update assignment status
   */
  async updateStatus(
    id: string,
    tenantId: string,
    status: string,
  ): Promise<ScoutingAssignment> {
    return this.prisma.scoutingAssignment.update({
      where: {
        id_tenantId: {
          id,
          tenantId,
        },
      },
      data: { status: status as any },
    });
  }

  /**
   * Get open assignments count for a scout
   */
  async getOpenAssignmentsCount(scoutId: string, tenantId: string): Promise<number> {
    return this.prisma.scoutingAssignment.count({
      where: {
        assignedToId: scoutId,
        tenantId,
        status: 'OPEN',
      },
    });
  }

  /**
   * Get all open assignments in a tenant
   */
  async getOpenAssignments(tenantId: string): Promise<ScoutingAssignment[]> {
    return this.prisma.scoutingAssignment.findMany({
      where: {
        tenantId,
        status: 'OPEN',
      },
      include: {
        assignedTo: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        assignedBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Delete assignment (soft delete not implemented - assignments are typically archived via status)
   */
  async delete(id: string, tenantId: string): Promise<ScoutingAssignment> {
    return this.prisma.scoutingAssignment.delete({
      where: {
        id_tenantId: {
          id,
          tenantId,
        },
      },
    });
  }
}
