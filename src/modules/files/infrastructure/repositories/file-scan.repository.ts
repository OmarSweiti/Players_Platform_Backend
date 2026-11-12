import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import type { TenantTx } from '../../../../common/tenancy/tenant-transaction';
import { objectKeyOf } from '../../../../infrastructure/storage/object-keys';
import {
  FileScans,
  type FileToScan,
  type Promotion,
} from '../../application/ports/file-scans.port';

const SELECTED = {
  id: true,
  status: true,
  scanVerdict: true,
  scanAttempts: true,
  quarantineKey: true,
  quarantineVersionId: true,
  sizeBytes: true,
} as const satisfies Prisma.FileObjectSelect;

type Selected = Prisma.FileObjectGetPayload<{ select: typeof SELECTED }>;

/**
 * The files the scan works on (0.8.4), on the tenant transaction, with
 * `ctx.tenantId` in every predicate; row-level security is the backstop.
 * Each transition names the state it leaves, so a file that moved on is
 * never moved twice; the database's CHECKs hold the rest — a time with each
 * verdict, a finding only when infected, a promoted copy only when clean and
 * hashed, READY only when clean, promoted and finalized — and its trigger
 * keeps a promoted file's identity.
 */
@Injectable()
export class FileScanRepository implements FileScans {
  async find(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
  ): Promise<FileToScan | null> {
    const file = await tx.fileObject.findFirst({
      where: { id, tenantId: ctx.tenantId },
      select: SELECTED,
    });
    return file === null ? null : viewOf(ctx, file);
  }

  async lock(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
  ): Promise<FileToScan | null> {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id::text AS id FROM file_objects
       WHERE id = ${id}::uuid AND tenant_id = ${ctx.tenantId}::uuid
         FOR UPDATE`;
    return locked.length === 0 ? null : this.find(tx, ctx, id);
  }

  async startScan(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
  ): Promise<void> {
    await tx.fileObject.updateMany({
      where: { id, tenantId: ctx.tenantId, status: 'UPLOADED' },
      data: { status: 'SCANNING' },
    });
  }

  async countAttempt(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
  ): Promise<number> {
    const counted = await tx.fileObject.update({
      where: { id_tenantId: { id, tenantId: ctx.tenantId } },
      data: { scanAttempts: { increment: 1 } },
      select: { scanAttempts: true },
    });
    return counted.scanAttempts;
  }

  async promote(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
    promotion: Promotion,
    at: Date,
  ): Promise<void> {
    await tx.fileObject.updateMany({
      where: { id, tenantId: ctx.tenantId, status: 'SCANNING' },
      data: {
        status: 'READY',
        scanVerdict: 'CLEAN',
        scannedAt: at,
        objectKey: promotion.objectKey,
        objectVersionId: promotion.objectVersionId,
        sha256: new Uint8Array(promotion.sha256),
        finalizedAt: at,
      },
    });
  }

  async reject(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
    finding: string,
    at: Date,
  ): Promise<void> {
    await tx.fileObject.updateMany({
      where: { id, tenantId: ctx.tenantId, status: 'SCANNING' },
      data: {
        status: 'REJECTED',
        scanVerdict: 'INFECTED',
        scanFinding: finding,
        scannedAt: at,
      },
    });
  }

  async fail(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
    at: Date,
  ): Promise<void> {
    await tx.fileObject.updateMany({
      where: { id, tenantId: ctx.tenantId, status: 'SCANNING' },
      data: { status: 'FAILED', scanVerdict: 'ERROR', scannedAt: at },
    });
  }
}

function viewOf(ctx: AuthorizedTenantContext, row: Selected): FileToScan {
  return {
    id: row.id,
    status: row.status,
    scanVerdict: row.scanVerdict,
    scanAttempts: row.scanAttempts,
    quarantineKey: objectKeyOf(ctx, row.quarantineKey, 'quarantine'),
    quarantineVersionId: row.quarantineVersionId,
    sizeBytes: Number(row.sizeBytes),
  };
}
