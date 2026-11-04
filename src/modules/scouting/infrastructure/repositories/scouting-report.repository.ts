import { Injectable } from '@nestjs/common';
import type {
  Prisma,
  RecommendationLevel,
  ScoutingReport,
  ScoutReportStatus,
} from '@prisma/client';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import type { TenantTx } from '../../../../common/tenancy/tenant-transaction';
import {
  ScoutingReports,
  type CreateScoutingReportInput,
  type UpdateScoutingReportInput,
} from '../../application/ports/scouting-reports.port';

const SCOUT = { select: { id: true, firstName: true, lastName: true } };
const SCOUT_WITH_EMAIL = {
  select: { id: true, firstName: true, lastName: true, email: true },
};

/**
 * Scouting reports, on the tenant transaction (0.4.12): every method takes
 * the transaction and the verified context, and writes `ctx.tenantId` into
 * its predicate; row-level security is the backstop. Only live reports are
 * read or changed: an archived one (`deletedAt` set) is gone (DB-57).
 */
@Injectable()
export class ScoutingReportRepository implements ScoutingReports {
  /** The report of the context's tenant with this id, live, as a predicate. */
  private live(ctx: AuthorizedTenantContext, id: string) {
    return { id_tenantId: { id, tenantId: ctx.tenantId }, deletedAt: null };
  }

  async create(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    data: CreateScoutingReportInput,
  ): Promise<ScoutingReport> {
    return tx.scoutingReport.create({
      data: {
        ...data,
        tenantId: ctx.tenantId,
        reportDate: new Date(),
        status: 'DRAFT',
      },
      include: { player: true, scout: SCOUT_WITH_EMAIL },
    });
  }

  async findById(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
  ): Promise<ScoutingReport | null> {
    return tx.scoutingReport.findUnique({
      where: this.live(ctx, id),
      include: { player: true, scout: SCOUT_WITH_EMAIL },
    });
  }

  async findMany(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    filters: {
      status?: ScoutReportStatus;
      scoutId?: string;
      playerId?: string;
      recommendation?: RecommendationLevel;
      dateFrom?: Date;
      dateTo?: Date;
    } = {},
    pagination: { skip?: number; take?: number } = {},
  ): Promise<{ reports: ScoutingReport[]; total: number }> {
    const where: Prisma.ScoutingReportWhereInput = {
      tenantId: ctx.tenantId,
      deletedAt: null,
      status: filters.status,
      scoutId: filters.scoutId,
      playerId: filters.playerId,
      recommendation: filters.recommendation,
      reportDate:
        filters.dateFrom || filters.dateTo
          ? { gte: filters.dateFrom, lte: filters.dateTo }
          : undefined,
    };
    const reports = await tx.scoutingReport.findMany({
      where,
      include: {
        player: { select: { id: true, fullName: true, position: true } },
        scout: SCOUT,
      },
      orderBy: { reportDate: 'desc' },
      skip: pagination.skip,
      take: pagination.take,
    });
    return { reports, total: await tx.scoutingReport.count({ where }) };
  }

  async update(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
    data: UpdateScoutingReportInput,
  ): Promise<ScoutingReport> {
    return tx.scoutingReport.update({
      where: this.live(ctx, id),
      data,
      include: { player: true, scout: SCOUT },
    });
  }

  /** Archives a live report; one already archived is not found. */
  async archive(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
  ): Promise<ScoutingReport> {
    return tx.scoutingReport.update({
      where: this.live(ctx, id),
      data: { deletedAt: new Date() },
    });
  }

  async submitReport(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
  ): Promise<ScoutingReport> {
    return tx.scoutingReport.update({
      where: this.live(ctx, id),
      data: { status: 'SUBMITTED' },
    });
  }

  async approveReport(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
    recommendation: RecommendationLevel,
  ): Promise<ScoutingReport> {
    return tx.scoutingReport.update({
      where: this.live(ctx, id),
      data: { status: 'APPROVED', recommendation },
    });
  }

  async rejectReport(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
  ): Promise<ScoutingReport> {
    return tx.scoutingReport.update({
      where: this.live(ctx, id),
      data: { status: 'REJECTED' },
    });
  }

  async getStatsByScout(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    scoutId: string,
  ): Promise<{
    total: number;
    draft: number;
    submitted: number;
    approved: number;
  }> {
    const count = (status?: ScoutReportStatus) =>
      tx.scoutingReport.count({
        where: { scoutId, tenantId: ctx.tenantId, deletedAt: null, status },
      });
    // One after another: a transaction is one connection.
    return {
      total: await count(),
      draft: await count('DRAFT'),
      submitted: await count('SUBMITTED'),
      approved: await count('APPROVED'),
    };
  }
}
