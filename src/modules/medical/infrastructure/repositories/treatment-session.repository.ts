import { Injectable } from '@nestjs/common';
import type { Prisma, TreatmentSession, TreatmentStatus } from '@prisma/client';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import type { TenantTx } from '../../../../common/tenancy/tenant-transaction';
import {
  TreatmentSessions,
  type CreateTreatmentSessionInput,
  type UpdateTreatmentSessionInput,
} from '../../application/ports/treatment-sessions.port';

const CONDUCTOR = {
  select: { id: true, firstName: true, lastName: true, role: true },
};
const DETAIL = {
  player: { select: { id: true, fullName: true, position: true } },
  medicalRecord: { select: { id: true, injuryType: true, bodyPart: true } },
  conductor: CONDUCTOR,
};

/**
 * Treatment sessions, on the tenant transaction (0.4.12): every method takes
 * the transaction and the verified context, and writes `ctx.tenantId` into
 * its predicate. A session has no archive yet; `0.6.8` replaces its deletion.
 */
@Injectable()
export class TreatmentSessionRepository implements TreatmentSessions {
  async create(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    data: CreateTreatmentSessionInput,
  ): Promise<TreatmentSession> {
    return tx.treatmentSession.create({
      data: {
        ...data,
        tenantId: ctx.tenantId,
        status: data.status ?? 'SCHEDULED',
      },
      include: DETAIL,
    });
  }

  async findById(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
  ): Promise<TreatmentSession | null> {
    return tx.treatmentSession.findUnique({
      where: { id_tenantId: { id, tenantId: ctx.tenantId } },
      include: DETAIL,
    });
  }

  async findByPlayer(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    playerId: string,
    filters: {
      status?: TreatmentStatus;
      medicalRecordId?: string;
      dateFrom?: Date;
      dateTo?: Date;
    } = {},
    pagination: { skip?: number; take?: number } = {},
  ): Promise<{ sessions: TreatmentSession[]; total: number }> {
    const where: Prisma.TreatmentSessionWhereInput = {
      playerId,
      tenantId: ctx.tenantId,
      status: filters.status,
      medicalRecordId: filters.medicalRecordId,
      sessionDate:
        filters.dateFrom || filters.dateTo
          ? { gte: filters.dateFrom, lte: filters.dateTo }
          : undefined,
    };
    const sessions = await tx.treatmentSession.findMany({
      where,
      include: { conductor: CONDUCTOR },
      orderBy: { sessionDate: 'desc' },
      skip: pagination.skip,
      take: pagination.take,
    });
    return { sessions, total: await tx.treatmentSession.count({ where }) };
  }

  async update(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
    data: UpdateTreatmentSessionInput,
  ): Promise<TreatmentSession> {
    return tx.treatmentSession.update({
      where: { id_tenantId: { id, tenantId: ctx.tenantId } },
      data,
    });
  }

  async updateStatus(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
    status: TreatmentStatus,
  ): Promise<TreatmentSession> {
    return tx.treatmentSession.update({
      where: { id_tenantId: { id, tenantId: ctx.tenantId } },
      data: { status },
    });
  }

  async delete(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
  ): Promise<TreatmentSession> {
    return tx.treatmentSession.delete({
      where: { id_tenantId: { id, tenantId: ctx.tenantId } },
    });
  }

  async getUpcomingSessions(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    playerId: string,
  ): Promise<TreatmentSession[]> {
    return tx.treatmentSession.findMany({
      where: {
        playerId,
        tenantId: ctx.tenantId,
        status: 'SCHEDULED',
        sessionDate: { gte: new Date() },
      },
      orderBy: { sessionDate: 'asc' },
    });
  }

  async getSessionStats(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    playerId: string,
  ): Promise<{
    total: number;
    scheduled: number;
    inProgress: number;
    completed: number;
  }> {
    const where = { playerId, tenantId: ctx.tenantId };
    const count = (status?: TreatmentStatus) =>
      tx.treatmentSession.count({ where: { ...where, status } });
    // One after another: a transaction is one connection.
    return {
      total: await count(),
      scheduled: await count('SCHEDULED'),
      inProgress: await count('IN_PROGRESS'),
      completed: await count('COMPLETED'),
    };
  }
}
