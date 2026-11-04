import { Injectable } from '@nestjs/common';
import type { MedicalRecord, Prisma } from '@prisma/client';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import type { TenantTx } from '../../../../common/tenancy/tenant-transaction';
import {
  MedicalRecords,
  type CreateMedicalRecordInput,
  type UpdateMedicalRecordInput,
} from '../../application/ports/medical-records.port';

const PLAYER = { select: { id: true, fullName: true, position: true } };
const AUTHOR = {
  select: { id: true, firstName: true, lastName: true, role: true },
};

/**
 * Medical records, on the tenant transaction (0.4.12): every method takes the
 * transaction and the verified context, and writes `ctx.tenantId` into its
 * predicate; row-level security is the backstop. An ordinary read sees live
 * records only: an archived one (`deletedAt` set) is gone (DB-57).
 */
@Injectable()
export class MedicalRecordRepository implements MedicalRecords {
  async create(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    data: CreateMedicalRecordInput,
  ): Promise<MedicalRecord> {
    return tx.medicalRecord.create({
      data: {
        ...data,
        tenantId: ctx.tenantId,
        isConfidential: data.isConfidential ?? true,
      },
      include: { player: PLAYER, createdBy: AUTHOR },
    });
  }

  async findById(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
  ): Promise<MedicalRecord | null> {
    return tx.medicalRecord.findFirst({
      where: { id, tenantId: ctx.tenantId, deletedAt: null },
      include: { player: PLAYER, createdBy: AUTHOR },
    });
  }

  async findByPlayer(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    playerId: string,
    filters: {
      injuryType?: string;
      isConfidential?: boolean;
      dateFrom?: Date;
      dateTo?: Date;
    } = {},
    pagination: { skip?: number; take?: number } = {},
  ): Promise<{ records: MedicalRecord[]; total: number }> {
    const where: Prisma.MedicalRecordWhereInput = {
      playerId,
      tenantId: ctx.tenantId,
      deletedAt: null,
      injuryType: filters.injuryType,
      isConfidential: filters.isConfidential,
      injuryDate:
        filters.dateFrom || filters.dateTo
          ? { gte: filters.dateFrom, lte: filters.dateTo }
          : undefined,
    };
    const records = await tx.medicalRecord.findMany({
      where,
      include: { createdBy: AUTHOR },
      orderBy: { injuryDate: 'desc' },
      skip: pagination.skip,
      take: pagination.take,
    });
    return { records, total: await tx.medicalRecord.count({ where }) };
  }

  async findAll(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    filters: {
      playerId?: string;
      injuryType?: string;
      isConfidential?: boolean;
    } = {},
    pagination: { skip?: number; take?: number } = {},
  ): Promise<{ records: MedicalRecord[]; total: number }> {
    const where: Prisma.MedicalRecordWhereInput = {
      tenantId: ctx.tenantId,
      deletedAt: null,
      playerId: filters.playerId,
      injuryType: filters.injuryType,
      isConfidential: filters.isConfidential,
    };
    const records = await tx.medicalRecord.findMany({
      where,
      include: { player: PLAYER, createdBy: AUTHOR },
      orderBy: { createdAt: 'desc' },
      skip: pagination.skip,
      take: pagination.take,
    });
    return { records, total: await tx.medicalRecord.count({ where }) };
  }

  /** Changes a live record; an archived one is not found. */
  async update(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
    data: UpdateMedicalRecordInput,
  ): Promise<MedicalRecord> {
    return tx.medicalRecord.update({
      where: { id_tenantId: { id, tenantId: ctx.tenantId }, deletedAt: null },
      data,
    });
  }

  /** Archives a live record; one already archived is not found. */
  async archive(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
  ): Promise<MedicalRecord> {
    return tx.medicalRecord.update({
      where: { id_tenantId: { id, tenantId: ctx.tenantId }, deletedAt: null },
      data: { deletedAt: new Date() },
    });
  }

  async getActiveInjuries(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    playerId: string,
  ): Promise<MedicalRecord[]> {
    return tx.medicalRecord.findMany({
      where: {
        playerId,
        tenantId: ctx.tenantId,
        deletedAt: null,
        recoveryDate: null, // not yet recovered
      },
      orderBy: { injuryDate: 'desc' },
    });
  }

  async getPlayerInjuryHistory(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    playerId: string,
  ): Promise<{
    total: number;
    byType: Array<{ injuryType: string; _count: number }>;
    bySeverity: Array<{ severity: string | null; _count: number }>;
  }> {
    const where = { playerId, tenantId: ctx.tenantId, deletedAt: null };
    // One after another: a transaction is one connection, which runs one
    // statement at a time.
    const total = await tx.medicalRecord.count({ where });
    const byType = await tx.medicalRecord.groupBy({
      by: ['injuryType'],
      where,
      _count: true,
    });
    const bySeverity = await tx.medicalRecord.groupBy({
      by: ['severity'],
      where,
      _count: true,
    });
    return { total, byType, bySeverity };
  }
}
