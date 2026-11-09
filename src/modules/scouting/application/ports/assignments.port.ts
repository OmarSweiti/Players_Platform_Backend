import type { PlayerPosition, ScoutingAssignment } from '@prisma/client';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import type { TenantTx } from '../../../../common/tenancy/tenant-transaction';

export interface CreateScoutingAssignmentInput {
  assignedToId: string;
  assignedById: string;
  region?: string;
  competition?: string;
  targetPosition?: PlayerPosition;
  minAge?: number;
  maxAge?: number;
  dueDate?: Date;
  notes?: string;
}

export interface UpdateScoutingAssignmentInput {
  /** Gives the assignment to another of the tenant's members. */
  assignedToId?: string;
  region?: string;
  competition?: string;
  targetPosition?: PlayerPosition;
  minAge?: number;
  maxAge?: number;
  dueDate?: Date;
  status?: string;
  notes?: string;
}

/**
 * Scouting assignments, as the use cases need them (0.4.12): a port the module
 * wires to AssignmentRepository. Every method takes the tenant transaction and
 * the verified context first; none takes a tenant id.
 */
export abstract class Assignments {
  abstract create(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    data: CreateScoutingAssignmentInput,
  ): Promise<ScoutingAssignment>;

  abstract findById(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
  ): Promise<ScoutingAssignment | null>;

  abstract getAssignmentsByScout(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    scoutId: string,
    status?: string,
  ): Promise<ScoutingAssignment[]>;

  abstract getAssignmentsByDirector(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    directorId: string,
    status?: string,
  ): Promise<ScoutingAssignment[]>;

  abstract update(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
    data: UpdateScoutingAssignmentInput,
  ): Promise<ScoutingAssignment>;

  abstract updateStatus(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
    status: string,
  ): Promise<ScoutingAssignment>;

  abstract delete(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
  ): Promise<ScoutingAssignment>;
}
