import type {
  PlayerPosition,
  Prisma,
  RecommendationLevel,
  ScoutingReport,
  ScoutReportStatus,
} from '@prisma/client';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import type { TenantTx } from '../../../../common/tenancy/tenant-transaction';

export interface CreateScoutingReportInput {
  scoutId: string;
  playerId?: string;
  prospectName?: string;
  prospectAge?: number;
  prospectClub?: string;
  prospectPosition?: PlayerPosition;
  prospectNationality?: string;
  recommendation?: RecommendationLevel;
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
  metadata?: Prisma.InputJsonValue;
}

export interface UpdateScoutingReportInput {
  status?: ScoutReportStatus;
  recommendation?: RecommendationLevel;
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

/**
 * Scouting reports, as the use cases need them (0.4.12): a port the module
 * wires to ScoutingReportRepository. Every method takes the tenant transaction
 * and the verified context first; none takes a tenant id.
 */
export abstract class ScoutingReports {
  abstract create(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    data: CreateScoutingReportInput,
  ): Promise<ScoutingReport>;

  abstract findById(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
  ): Promise<ScoutingReport | null>;

  abstract findMany(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    filters?: {
      status?: ScoutReportStatus;
      scoutId?: string;
      playerId?: string;
      recommendation?: RecommendationLevel;
      dateFrom?: Date;
      dateTo?: Date;
    },
    pagination?: { skip?: number; take?: number },
  ): Promise<{ reports: ScoutingReport[]; total: number }>;

  abstract update(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
    data: UpdateScoutingReportInput,
  ): Promise<ScoutingReport>;

  abstract archive(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
  ): Promise<ScoutingReport>;

  abstract submitReport(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
  ): Promise<ScoutingReport>;

  abstract approveReport(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
    recommendation: RecommendationLevel,
  ): Promise<ScoutingReport>;

  abstract rejectReport(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
  ): Promise<ScoutingReport>;

  abstract getStatsByScout(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    scoutId: string,
  ): Promise<{
    total: number;
    draft: number;
    submitted: number;
    approved: number;
  }>;
}
