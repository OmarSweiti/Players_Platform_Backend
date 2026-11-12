import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import type { TenantTx } from '../../../../common/tenancy/tenant-transaction';
import type { ObjectKey } from '../../../../infrastructure/storage/object-keys';
import type { FileStatus, ScanVerdict } from '../../domain/file-object';

/** A file as its scan sees it: where its bytes are, and how far it has come. */
export interface FileToScan {
  readonly id: string;
  readonly status: FileStatus;
  readonly scanVerdict: ScanVerdict;
  readonly scanAttempts: number;
  readonly quarantineKey: ObjectKey;
  /** The exact version completion pinned (0.8.3): what is scanned and copied. */
  readonly quarantineVersionId: string | null;
  readonly sizeBytes: number;
}

/** A clean file's immutable copy: its key, its version, and its bytes' hash. */
export interface Promotion {
  readonly objectKey: ObjectKey;
  readonly objectVersionId: string;
  readonly sha256: Buffer;
}

/**
 * The files the scan works on (0.8.4), in the context's tenant: each change
 * is one transition, and each takes the file as it is — the caller locks it
 * first.
 */
export abstract class FileScans {
  abstract find(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
  ): Promise<FileToScan | null>;

  /** The file, its row locked until the transaction ends; null if none. */
  abstract lock(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
  ): Promise<FileToScan | null>;

  /** `UPLOADED` → `SCANNING`. */
  abstract startScan(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
  ): Promise<void>;

  /** One more try counted; the count it reaches. */
  abstract countAttempt(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
  ): Promise<number>;

  /** `SCANNING` → `READY`, `CLEAN`, with its immutable copy. */
  abstract promote(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
    promotion: Promotion,
    at: Date,
  ): Promise<void>;

  /** `SCANNING` → `REJECTED`, `INFECTED`, with what was found. */
  abstract reject(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
    finding: string,
    at: Date,
  ): Promise<void>;

  /** `SCANNING` → `FAILED`, `ERROR`: no verdict was reached. */
  abstract fail(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    id: string,
    at: Date,
  ): Promise<void>;
}
