import { Inject, Injectable } from '@nestjs/common';
import {
  InvalidTransitionError,
  NotFoundError,
} from '../../../../common/errors/domain-error';
import { Idempotency } from '../../../../common/idempotency/idempotency';
import type { IdempotentRequest } from '../../../../common/idempotency/idempotent-request';
import { authorizeChange } from '../../../../common/policy/policy';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import { TenantTransactions } from '../../../../common/tenancy/tenant-transaction';
import { CLOCK, type Clock } from '../../../../common/time/clock';
import { AuditService } from '../../../../infrastructure/audit/audit.service';
import { Outbox } from '../../../../infrastructure/outbox/outbox';
import {
  ObjectNotFound,
  StoragePort,
} from '../../../../infrastructure/storage/storage.port';
import {
  hasSignatureOf,
  SIGNATURE_BYTES,
} from '../../domain/content-signature';
import { uploadStateOf } from '../../domain/upload-session';
import { UploadRecords, type UploadView } from '../ports/upload-records.port';
import {
  UploadContentMismatchError,
  UploadIncompleteError,
} from '../upload-errors';
import { uploadPolicy } from '../upload.policy';

/**
 * What the store holds of an upload's file, read before anything is
 * written: the exact version that arrived, and whether it is the file
 * declared — or why not.
 */
type Inspection =
  | { readonly versionId: string; readonly matches: true }
  | {
      readonly versionId: string;
      readonly matches: false;
      readonly why: 'size' | 'type' | 'signature';
    };

/**
 * Completing an upload (0.8.3; SR-DOC-003, SR-NFR-PERF-002), by its uploader
 * alone — another member's is not found. The store is read first, outside any
 * transaction: the newest version of the file's quarantine key, its size and
 * type against the declaration, and its first bytes against the declared
 * type's signature. Then, the upload locked, that **exact version** is
 * pinned — whatever is sent to the key later, the scan reads this one — the
 * file is `UPLOADED`, the upload closes, and the scan is queued
 * (`file.uploaded`), audited, all in one transaction. Nothing is processed
 * in the request.
 *
 * Nothing arrived yet: `UPLOAD_INCOMPLETE`, before any key is claimed, so the
 * same request completes once the file is in. Another file than the one
 * declared: `UPLOAD_CONTENT_MISMATCH`, and the file stays unpinned and
 * unscanned — never readable — until the upload ends. A retry with the same
 * key is answered as the first was; an upload completed by another request
 * is answered as it stands.
 */
@Injectable()
export class CompleteUploadUseCase {
  constructor(
    private readonly transactions: TenantTransactions,
    private readonly records: UploadRecords,
    private readonly storage: StoragePort,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditService,
    private readonly outbox: Outbox,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(
    ctx: AuthorizedTenantContext,
    request: IdempotentRequest,
    uploadId: string,
  ): Promise<UploadView> {
    const upload = await this.transactions.withTenantTransaction(
      ctx,
      async (tx) =>
        authorizeChange(
          ctx,
          uploadPolicy,
          'complete',
          await this.records.find(tx, ctx, uploadId),
          'no such upload in this tenant',
        ),
    );
    const state = uploadStateOf(upload, this.clock.now());
    if (state === 'aborted' || state === 'expired') {
      throw new InvalidTransitionError(`the upload is ${state}`);
    }
    const inspection = state === 'open' ? await this.inspect(upload) : null;

    return this.idempotency.run(
      ctx,
      request,
      { uploadId },
      {
        execute: async (tx) => {
          const locked = await this.records.lock(tx, ctx, uploadId);
          if (locked === null) throw new NotFoundError('the upload is gone');
          const now = this.clock.now();
          const current = uploadStateOf(locked, now);
          // Completed by another request meanwhile: as it stands.
          if (current === 'finalized') {
            return { result: locked, resultRef: locked.id };
          }
          if (current !== 'open' || inspection === null) {
            throw new InvalidTransitionError(`the upload is ${current}`);
          }
          if (!inspection.matches) {
            throw new UploadContentMismatchError(
              `the file that arrived differs in its ${inspection.why}`,
            );
          }
          const pinned = await this.records.pin(
            tx,
            ctx,
            locked,
            inspection.versionId,
            now,
          );
          await this.audit.record(tx, ctx, {
            action: 'file.uploaded',
            entityId: pinned.fileId,
            before: { status: locked.status },
            after: {
              status: pinned.status,
              quarantineVersionId: inspection.versionId,
            },
          });
          // The scan (0.8.4), once this commits.
          await this.outbox.enqueue(tx, ctx, {
            type: 'file.uploaded',
            aggregateId: pinned.fileId,
            refs: { fileObjectId: pinned.fileId },
            dedupKey: `file.uploaded:${pinned.fileId}`,
          });
          return { result: pinned, resultRef: pinned.id };
        },
        replay: async (tx, resultRef) => {
          const found =
            resultRef === null
              ? null
              : await this.records.find(tx, ctx, resultRef);
          if (found === null) throw new NotFoundError('the upload is gone');
          return found;
        },
      },
    );
  }

  /**
   * The newest version of the file's quarantine key, as the store holds it:
   * its size and type against the declaration, then its first bytes against
   * the declared type's signature. Nothing there: incomplete.
   */
  private async inspect(upload: UploadView): Promise<Inspection> {
    const head = await this.storage.head(upload.quarantineKey);
    if (head === null) {
      throw new UploadIncompleteError('nothing has arrived in quarantine');
    }
    const { versionId } = head;
    if (head.sizeBytes !== upload.sizeBytes) {
      return { versionId, matches: false, why: 'size' };
    }
    if (head.contentType !== upload.type) {
      return { versionId, matches: false, why: 'type' };
    }
    let first: Buffer;
    try {
      first = await this.storage.readRange(
        { key: upload.quarantineKey, versionId },
        0,
        Math.min(SIGNATURE_BYTES, head.sizeBytes) - 1,
      );
    } catch (error) {
      // The version went between the two reads: nothing to pin yet.
      if (error instanceof ObjectNotFound) {
        throw new UploadIncompleteError('the version that arrived is gone');
      }
      throw error;
    }
    return hasSignatureOf(upload.type, first)
      ? { versionId, matches: true }
      : { versionId, matches: false, why: 'signature' };
  }
}
