import { Injectable } from '@nestjs/common';
import type { ScoutingAssignment } from '@prisma/client';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import type { TenantTx } from '../../../../common/tenancy/tenant-transaction';
import {
  Assignments,
  type CreateScoutingAssignmentInput,
  type UpdateScoutingAssignmentInput,
} from '../../application/ports/assignments.port';

const PERSON = {
  select: { id: true, firstName: true, lastName: true, email: true },
};

/**
 * Scouting assignments, on the tenant transaction (0.4.12): every method takes
 * the transaction and the verified context, and writes `ctx.tenantId` into its
 * predicate. An assignment is deleted outright until `1.11.2` cancels instead.
 */
@Injectable()
export class AssignmentRepository implements Assignments {
  async create(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    data: CreateScoutingAssignmentInput,
  ): Promise<ScoutingAssignment> {
    return tx.scoutingAssignment.create({
      data: { ...data, tenantId: ctx.tenantId, status: 'OPEN' },
      include: { assignedTo: PERSON, assignedBy: PERSON },
    });
  }

  async findById(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
  ): Promise<ScoutingAssignment | null> {
    return tx.scoutingAssignment.findUnique({
      where: { id_tenantId: { id, tenantId: ctx.tenantId } },
      include: { assignedTo: PERSON, assignedBy: PERSON },
    });
  }

  /** The assignments given to a scout. */
  async getAssignmentsByScout(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    scoutId: string,
    status?: string,
  ): Promise<ScoutingAssignment[]> {
    return tx.scoutingAssignment.findMany({
      where: { assignedToId: scoutId, tenantId: ctx.tenantId, status },
      include: { assignedBy: PERSON },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** The assignments a sporting director gave. */
  async getAssignmentsByDirector(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    directorId: string,
    status?: string,
  ): Promise<ScoutingAssignment[]> {
    return tx.scoutingAssignment.findMany({
      where: { assignedById: directorId, tenantId: ctx.tenantId, status },
      include: { assignedTo: PERSON },
      orderBy: { createdAt: 'desc' },
    });
  }

  async update(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
    data: UpdateScoutingAssignmentInput,
  ): Promise<ScoutingAssignment> {
    return tx.scoutingAssignment.update({
      where: { id_tenantId: { id, tenantId: ctx.tenantId } },
      data,
    });
  }

  async updateStatus(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
    status: string,
  ): Promise<ScoutingAssignment> {
    return tx.scoutingAssignment.update({
      where: { id_tenantId: { id, tenantId: ctx.tenantId } },
      data: { status },
    });
  }

  async delete(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
  ): Promise<ScoutingAssignment> {
    return tx.scoutingAssignment.delete({
      where: { id_tenantId: { id, tenantId: ctx.tenantId } },
    });
  }
}
