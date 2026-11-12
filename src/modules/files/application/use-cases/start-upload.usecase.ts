import { Inject, Injectable } from '@nestjs/common';
import {
  type FieldIssue,
  NotFoundError,
  ValidationFailedError,
} from '../../../../common/errors/domain-error';
import { Idempotency } from '../../../../common/idempotency/idempotency';
import type { IdempotentRequest } from '../../../../common/idempotency/idempotent-request';
import { authorizeChange } from '../../../../common/policy/policy';
import {
  actingMemberOf,
  type AuthorizedTenantContext,
} from '../../../../common/tenancy/tenant-context';
import { TenantTransactions } from '../../../../common/tenancy/tenant-transaction';
import { CLOCK, type Clock } from '../../../../common/time/clock';
import { AuditService } from '../../../../infrastructure/audit/audit.service';
import { newObjectKey } from '../../../../infrastructure/storage/object-keys';
import {
  type PresignedRequest,
  StoragePort,
} from '../../../../infrastructure/storage/storage.port';
import { fileNameIssue, fileNameOf } from '../../domain/file-name';
import {
  extensionsFor,
  UPLOAD_KINDS,
  type UploadKindName,
  type UploadType,
} from '../../domain/upload-kinds';
import {
  UPLOAD_LINK_SECONDS,
  UPLOAD_WINDOW_MS,
  uploadStateOf,
} from '../../domain/upload-session';
import { UploadOwners } from '../ports/upload-owners.port';
import { UploadRecords, type UploadView } from '../ports/upload-records.port';
import { uploadOwnerPolicy } from '../upload.policy';

/** An upload, as its uploader asks for it: what it is for, and the file to come. */
export interface StartUpload {
  readonly ownerKind: UploadKindName;
  readonly ownerId: string;
  readonly fileName: string;
  readonly type: UploadType;
  readonly sizeBytes: number;
}

/** An upload, and the request that sends its file while it is open. */
export interface StartedUpload extends UploadView {
  readonly put: PresignedRequest | null;
}

/**
 * Starting an upload (0.8.3; SR-DOC-003, ADR-0009). The declaration is
 * checked first — a type the owner's kind takes, no larger than it allows, a
 * name safe to show — then the owner, by its policy: another tenant's, or
 * none, is not found. The file is made in quarantine, `UPLOADING`, under a
 * key from the key builder, never from its name; the upload stays open an
 * hour. The answer carries a presigned PUT into quarantine, ten minutes long
 * and bound to the declared type and size, which the store refuses to take
 * any other.
 *
 * A retried create (`Idempotency-Key`) makes one upload: a retry is answered
 * with the same upload and a fresh link while it is open.
 */
@Injectable()
export class StartUploadUseCase {
  constructor(
    private readonly transactions: TenantTransactions,
    private readonly owners: UploadOwners,
    private readonly records: UploadRecords,
    private readonly storage: StoragePort,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(
    ctx: AuthorizedTenantContext,
    request: IdempotentRequest,
    input: StartUpload,
  ): Promise<StartedUpload> {
    const uploaderId = actingMemberOf(ctx);
    const fileName = fileNameOf(input.fileName);
    const kind = UPLOAD_KINDS[input.ownerKind];
    admissible(input, fileName);

    // The owner, as the member may see it: another tenant's is not found.
    const owner = { kind: input.ownerKind, id: input.ownerId };
    await this.transactions.withTenantTransaction(ctx, async (tx) =>
      authorizeChange(
        ctx,
        uploadOwnerPolicy,
        'upload',
        await this.owners.find(tx, ctx, owner),
        'no such owner in this tenant',
      ),
    );

    const upload = await this.idempotency.run(ctx, request, input, {
      execute: async (tx) => {
        const now = this.clock.now();
        const created = await this.records.create(tx, ctx, {
          owner,
          quarantineKey: newObjectKey(ctx, 'quarantine'),
          fileName,
          type: input.type,
          sizeBytes: input.sizeBytes,
          classification: kind.classification,
          createdById: uploaderId,
          createdAt: now,
          expiresAt: new Date(now.getTime() + UPLOAD_WINDOW_MS),
        });
        await this.audit.record(tx, ctx, {
          action: 'file.upload_started',
          entityId: created.fileId,
          after: {
            ownerKind: owner.kind,
            ownerId: owner.id,
            fileName: created.fileName,
            type: created.type,
            sizeBytes: created.sizeBytes,
            expiresAt: created.expiresAt,
          },
        });
        return { result: created, resultRef: created.id };
      },
      replay: async (tx, resultRef) => {
        const found =
          resultRef === null
            ? null
            : await this.records.find(tx, ctx, resultRef);
        if (found === null) throw new NotFoundError('the upload is gone');
        return found;
      },
    });
    return { ...upload, put: await this.linkFor(upload) };
  }

  /**
   * The PUT that sends the file, while the upload is open: ten minutes at
   * most, and never past the upload's end.
   */
  private async linkFor(upload: UploadView): Promise<PresignedRequest | null> {
    const now = this.clock.now();
    if (uploadStateOf(upload, now) !== 'open') return null;
    const left = Math.floor(
      (upload.expiresAt.getTime() - now.getTime()) / 1000,
    );
    if (left < 1) return null;
    return this.storage.presignPut(upload.quarantineKey, {
      contentType: upload.type,
      contentLength: upload.sizeBytes,
      expiresInSeconds: Math.min(UPLOAD_LINK_SECONDS, left),
    });
  }
}

/**
 * The declaration, as the owner's kind takes it: its type, its size, and a
 * name safe to keep. Every issue at once, by field.
 */
function admissible(input: StartUpload, fileName: string): void {
  const kind = UPLOAD_KINDS[input.ownerKind];
  const extensions = extensionsFor(input.ownerKind, input.type);
  const issues: FieldIssue[] = [];
  if (extensions.length === 0) {
    issues.push({ field: '/type', code: 'INVALID_VALUE' });
  }
  if (input.sizeBytes > kind.maxBytes) {
    issues.push({ field: '/sizeBytes', code: 'TOO_BIG' });
  }
  if (
    fileNameIssue(
      fileName,
      extensions.length > 0 ? extensions : allExtensionsOf(input.ownerKind),
    ) !== null
  ) {
    issues.push({ field: '/fileName', code: 'INVALID_VALUE' });
  }
  if (issues.length > 0) {
    throw new ValidationFailedError(
      `${input.ownerKind}: the file is not one its owner takes`,
      issues,
    );
  }
}

/** Every extension `kind` takes, of any type: a name's own check, apart from its type's. */
function allExtensionsOf(kind: UploadKindName): readonly string[] {
  return Object.values(UPLOAD_KINDS[kind].types).flat();
}
