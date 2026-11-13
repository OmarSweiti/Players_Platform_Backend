import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import type { TenantTx } from '../../../../common/tenancy/tenant-transaction';
import type { ObjectVersion } from '../../../../infrastructure/storage/storage.port';
import type {
  FileClassification,
  FileStatus,
  ScanVerdict,
} from '../../domain/file-object';
import type { UploadOwnerRef } from './upload-records.port';

/**
 * A file as a download reads it (0.8.5): what it is for, its state, its
 * class, and — once promoted — the exact version that was scanned (0.8.4),
 * never its quarantine.
 */
export interface FileToDownload {
  readonly id: string;
  /** What it is for, from its upload; null when no known owner names it. */
  readonly owner: UploadOwnerRef | null;
  readonly status: FileStatus;
  readonly scanVerdict: ScanVerdict;
  readonly classification: FileClassification;
  /** The promoted version, and the SHA-256 of its bytes; null until promoted. */
  readonly promoted: {
    readonly version: ObjectVersion;
    readonly sha256: Buffer;
  } | null;
  readonly fileName: string;
  readonly type: string;
  readonly sizeBytes: number;
  /** When its objects were purged under an approved policy (1.3.4). */
  readonly purgedAt: Date | null;
}

/** The files of the context's tenant, as downloads read them (0.8.5): `file_objects`, with their upload's owner. */
export abstract class FileDownloads {
  abstract find(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
  ): Promise<FileToDownload | null>;
}
