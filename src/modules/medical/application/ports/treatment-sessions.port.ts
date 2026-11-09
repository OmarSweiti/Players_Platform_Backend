import type { TreatmentSession, TreatmentStatus } from '@prisma/client';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import type { TenantTx } from '../../../../common/tenancy/tenant-transaction';

export interface CreateTreatmentSessionInput {
  playerId: string;
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
  /** Moves the session to another of the tenant's players, or records. */
  playerId?: string;
  medicalRecordId?: string;
  sessionDate?: Date;
  duration?: number;
  status?: TreatmentStatus;
  treatmentType?: string;
  description?: string;
  exercises?: string;
  progressNotes?: string;
}

/**
 * Treatment sessions, as the use cases need them (0.4.12): a port the module
 * wires to TreatmentSessionRepository. Every method takes the tenant
 * transaction and the verified context first; none takes a tenant id.
 */
export abstract class TreatmentSessions {
  abstract create(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    data: CreateTreatmentSessionInput,
  ): Promise<TreatmentSession>;

  abstract findById(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
  ): Promise<TreatmentSession | null>;

  abstract findByPlayer(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    playerId: string,
    filters?: {
      status?: TreatmentStatus;
      medicalRecordId?: string;
      dateFrom?: Date;
      dateTo?: Date;
    },
    pagination?: { skip?: number; take?: number },
  ): Promise<{ sessions: TreatmentSession[]; total: number }>;

  abstract update(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
    data: UpdateTreatmentSessionInput,
  ): Promise<TreatmentSession>;

  abstract updateStatus(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
    status: TreatmentStatus,
  ): Promise<TreatmentSession>;

  abstract delete(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
  ): Promise<TreatmentSession>;

  abstract getUpcomingSessions(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    playerId: string,
  ): Promise<TreatmentSession[]>;

  abstract getSessionStats(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    playerId: string,
  ): Promise<{
    total: number;
    scheduled: number;
    inProgress: number;
    completed: number;
  }>;
}
