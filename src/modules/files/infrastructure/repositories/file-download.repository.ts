import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import type { TenantTx } from '../../../../common/tenancy/tenant-transaction';
import { objectKeyOf } from '../../../../infrastructure/storage/object-keys';
import {
  FileDownloads,
  type FileToDownload,
} from '../../application/ports/file-downloads.port';
import type { UploadOwnerRef } from '../../application/ports/upload-records.port';
import {
  UPLOAD_KIND_NAMES,
  type UploadKindName,
} from '../../domain/upload-kinds';

const SELECTED = {
  id: true,
  status: true,
  scanVerdict: true,
  classification: true,
  objectKey: true,
  objectVersionId: true,
  sha256: true,
  originalName: true,
  mimeType: true,
  sizeBytes: true,
  purgedAt: true,
  // Its upload's owner: one upload per file, its owner's kind and id alone.
  uploadSessions: { select: { ownerKind: true, ownerId: true }, take: 1 },
} as const satisfies Prisma.FileObjectSelect;

type Selected = Prisma.FileObjectGetPayload<{ select: typeof SELECTED }>;

/**
 * The files downloads read (0.8.5), on the tenant transaction, with
 * `ctx.tenantId` in the predicate; row-level security is the backstop. The
 * promoted key is read back only as the key builder made it, under this
 * tenant's `objects/` (0.8.1): a row holding any other key is refused, never
 * served.
 */
@Injectable()
export class FileDownloadRepository implements FileDownloads {
  async find(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
  ): Promise<FileToDownload | null> {
    const file = await tx.fileObject.findFirst({
      where: { id, tenantId: ctx.tenantId },
      select: SELECTED,
    });
    return file === null ? null : viewOf(ctx, file);
  }
}

function viewOf(ctx: AuthorizedTenantContext, row: Selected): FileToDownload {
  return {
    id: row.id,
    owner: ownerOf(row.uploadSessions[0]),
    status: row.status,
    scanVerdict: row.scanVerdict,
    classification: row.classification,
    promoted:
      row.objectKey === null ||
      row.objectVersionId === null ||
      row.sha256 === null
        ? null
        : {
            version: {
              key: objectKeyOf(ctx, row.objectKey, 'objects'),
              versionId: row.objectVersionId,
            },
            sha256: Buffer.from(row.sha256),
          },
    fileName: row.originalName,
    type: row.mimeType,
    sizeBytes: Number(row.sizeBytes),
    purgedAt: row.purgedAt,
  };
}

/** The owner an upload names, when it is of a kind this code knows. */
function ownerOf(
  upload: { readonly ownerKind: string; readonly ownerId: string } | undefined,
): UploadOwnerRef | null {
  if (upload === undefined) return null;
  const kind = UPLOAD_KIND_NAMES.find((name) => name === upload.ownerKind);
  return kind === undefined
    ? null
    : { kind: kind satisfies UploadKindName, id: upload.ownerId };
}
