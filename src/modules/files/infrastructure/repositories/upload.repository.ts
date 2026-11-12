import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import type { TenantTx } from '../../../../common/tenancy/tenant-transaction';
import { objectKeyOf } from '../../../../infrastructure/storage/object-keys';
import type { UploadKindName, UploadType } from '../../domain/upload-kinds';
import {
  type NewUpload,
  UploadRecords,
  type UploadView,
} from '../../application/ports/upload-records.port';

/** An upload's row and its file's, as a view is made of them: no more. */
const SELECTED = {
  id: true,
  ownerKind: true,
  ownerId: true,
  createdById: true,
  createdAt: true,
  expiresAt: true,
  finalizedAt: true,
  abortedAt: true,
  fileObject: {
    select: {
      id: true,
      status: true,
      quarantineKey: true,
      originalName: true,
      mimeType: true,
      sizeBytes: true,
    },
  },
} as const satisfies Prisma.UploadSessionSelect;

type Selected = Prisma.UploadSessionGetPayload<{ select: typeof SELECTED }>;

/**
 * The context tenant's uploads (0.8.3): an `upload_sessions` row and its
 * `file_objects` row, written together, on the tenant transaction, with
 * `ctx.tenantId` in every predicate; row-level security is the backstop.
 * Both are kept: a file is closed by its state, never removed (0.8.2). A
 * file's key is read back through the key builder, which refuses any key not
 * the context tenant's quarantine.
 */
@Injectable()
export class UploadRepository implements UploadRecords {
  async create(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    upload: NewUpload,
  ): Promise<UploadView> {
    const size = BigInt(upload.sizeBytes);
    const file = await tx.fileObject.create({
      data: {
        tenantId: ctx.tenantId,
        quarantineKey: upload.quarantineKey,
        sizeBytes: size,
        mimeType: upload.type,
        originalName: upload.fileName,
        status: 'UPLOADING',
        classification: upload.classification,
        createdById: upload.createdById,
        createdAt: upload.createdAt,
      },
      select: { id: true },
    });
    const session = await tx.uploadSession.create({
      data: {
        tenantId: ctx.tenantId,
        fileObjectId: file.id,
        createdById: upload.createdById,
        declaredSize: size,
        declaredType: upload.type,
        ownerKind: upload.owner.kind,
        ownerId: upload.owner.id,
        createdAt: upload.createdAt,
        expiresAt: upload.expiresAt,
      },
      select: SELECTED,
    });
    return viewOf(ctx, session);
  }

  async find(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
  ): Promise<UploadView | null> {
    const session = await tx.uploadSession.findFirst({
      where: { id, tenantId: ctx.tenantId },
      select: SELECTED,
    });
    return session === null ? null : viewOf(ctx, session);
  }

  async lock(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
  ): Promise<UploadView | null> {
    // The upload's row, locked until the transaction ends: one completion
    // at a time decides what is pinned.
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id::text AS id FROM upload_sessions
       WHERE id = ${id}::uuid AND tenant_id = ${ctx.tenantId}::uuid
         FOR UPDATE`;
    return locked.length === 0 ? null : this.find(tx, ctx, id);
  }

  async pin(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    upload: UploadView,
    versionId: string,
    at: Date,
  ): Promise<UploadView> {
    await tx.fileObject.update({
      where: { id_tenantId: { id: upload.fileId, tenantId: ctx.tenantId } },
      data: { status: 'UPLOADED', quarantineVersionId: versionId },
      select: { id: true },
    });
    const session = await tx.uploadSession.update({
      where: { id_tenantId: { id: upload.id, tenantId: ctx.tenantId } },
      data: { finalizedAt: at, revision: { increment: 1 } },
      select: SELECTED,
    });
    return viewOf(ctx, session);
  }
}

function viewOf(ctx: AuthorizedTenantContext, row: Selected): UploadView {
  const file = row.fileObject;
  return {
    id: row.id,
    fileId: file.id,
    status: file.status,
    owner: { kind: row.ownerKind as UploadKindName, id: row.ownerId },
    fileName: file.originalName,
    type: file.mimeType as UploadType,
    sizeBytes: Number(file.sizeBytes),
    quarantineKey: objectKeyOf(ctx, file.quarantineKey, 'quarantine'),
    createdById: row.createdById,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    finalizedAt: row.finalizedAt,
    abortedAt: row.abortedAt,
  };
}
