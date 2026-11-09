import type { MedicalRecord, Prisma } from '@prisma/client';
import { NotFoundError } from '../../../../common/errors/domain-error';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import type { TenantTx } from '../../../../common/tenancy/tenant-transaction';

export interface CreateMedicalRecordInput {
  playerId: string;
  createdById: string;
  injuryType: string;
  bodyPart?: string;
  severity?: string;
  description?: string;
  treatment?: string;
  injuryDate?: Date;
  recoveryDate?: Date;
  returnToPlayDate?: Date;
  isConfidential?: boolean;
  metadata?: Prisma.InputJsonValue;
}

export interface UpdateMedicalRecordInput {
  /** Moves the record to another of the tenant's players. */
  playerId?: string;
  injuryType?: string;
  bodyPart?: string;
  severity?: string;
  description?: string;
  treatment?: string;
  injuryDate?: Date;
  recoveryDate?: Date;
  returnToPlayDate?: Date;
  isConfidential?: boolean;
  metadata?: Prisma.InputJsonValue;
}

/**
 * Medical records, as the use cases need them (0.4.12): a port the module wires
 * to MedicalRecordRepository. Every method takes the tenant transaction and the
 * verified context first; none takes a tenant id.
 */
export abstract class MedicalRecords {
  abstract create(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    data: CreateMedicalRecordInput,
  ): Promise<MedicalRecord>;

  abstract findById(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
  ): Promise<MedicalRecord | null>;

  abstract findByPlayer(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    playerId: string,
    filters?: {
      injuryType?: string;
      isConfidential?: boolean;
      dateFrom?: Date;
      dateTo?: Date;
    },
    pagination?: { skip?: number; take?: number },
  ): Promise<{ records: MedicalRecord[]; total: number }>;

  abstract findAll(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    filters?: {
      playerId?: string;
      injuryType?: string;
      isConfidential?: boolean;
    },
    pagination?: { skip?: number; take?: number },
  ): Promise<{ records: MedicalRecord[]; total: number }>;

  abstract update(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
    data: UpdateMedicalRecordInput,
  ): Promise<MedicalRecord>;

  abstract archive(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
  ): Promise<MedicalRecord>;

  abstract getActiveInjuries(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    playerId: string,
  ): Promise<MedicalRecord[]>;

  abstract getPlayerInjuryHistory(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    playerId: string,
  ): Promise<{
    total: number;
    byType: Array<{ injuryType: string; _count: number }>;
    bySeverity: Array<{ severity: string | null; _count: number }>;
  }>;
}

/**
 * Not found unless `id` is a live medical record of the context's tenant:
 * another tenant's record answers as no one's does (0.6.9; SR-NFR-SEC-003).
 */
export async function requireRecord(
  records: MedicalRecords,
  tx: TenantTx,
  ctx: AuthorizedTenantContext,
  id: string,
): Promise<void> {
  if (!(await records.findById(tx, ctx, id))) {
    throw new NotFoundError('Medical record not found');
  }
}
