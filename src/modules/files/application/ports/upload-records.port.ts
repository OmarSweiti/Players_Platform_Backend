import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import type { TenantTx } from '../../../../common/tenancy/tenant-transaction';
import type { ObjectKey } from '../../../../infrastructure/storage/object-keys';
import type { FileClassification, FileStatus } from '../../domain/file-object';
import type { UploadKindName, UploadType } from '../../domain/upload-kinds';
import type { UploadWindow } from '../../domain/upload-session';

/** What an upload is for: a kind of owner, and its id (DB-69). */
export interface UploadOwnerRef {
  readonly kind: UploadKindName;
  readonly id: string;
}

/** An upload to begin: its file, in quarantine, and its window. */
export interface NewUpload {
  readonly owner: UploadOwnerRef;
  readonly quarantineKey: ObjectKey;
  readonly fileName: string;
  readonly type: UploadType;
  readonly sizeBytes: number;
  readonly classification: FileClassification;
  readonly createdById: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

/**
 * An upload, and its file as far as the upload knows it: never the pinned
 * version's id, which the scan reads (0.8.4), nor the store's key beyond the
 * use case that sends to it.
 */
export interface UploadView extends UploadWindow {
  readonly id: string;
  readonly fileId: string;
  readonly status: FileStatus;
  readonly owner: UploadOwnerRef;
  readonly fileName: string;
  readonly type: UploadType;
  readonly sizeBytes: number;
  readonly quarantineKey: ObjectKey;
  readonly createdById: string;
  readonly createdAt: Date;
}

/** The uploads of the context's tenant (0.8.3): `upload_sessions` with their `file_objects`. */
export abstract class UploadRecords {
  abstract create(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    upload: NewUpload,
  ): Promise<UploadView>;

  abstract find(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
  ): Promise<UploadView | null>;

  /** The upload, its row locked until the transaction ends; null if none. */
  abstract lock(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
  ): Promise<UploadView | null>;

  /**
   * Pins the file's exact quarantined version and marks it `UPLOADED`, and
   * closes the upload, finalized at `at`.
   */
  abstract pin(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    upload: UploadView,
    versionId: string,
    at: Date,
  ): Promise<UploadView>;
}
