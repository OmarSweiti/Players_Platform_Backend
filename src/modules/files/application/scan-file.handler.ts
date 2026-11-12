import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AuthorizedTenantContext } from '../../../common/tenancy/tenant-context';
import {
  TenantTransactions,
  type TenantTx,
} from '../../../common/tenancy/tenant-transaction';
import { CLOCK, type Clock } from '../../../common/time/clock';
import { AuditService } from '../../../infrastructure/audit/audit.service';
import {
  type DeliveredEvent,
  EffectFailedForGood,
  OutboxConsumer,
} from '../../../infrastructure/outbox/outbox-consumers';
import { DELIVERY } from '../../../infrastructure/queue/outbox-queue';
import { errorCodeOf } from '../../../infrastructure/queue/outbox-worker';
import {
  type ScanResult,
  ScanNotCompleted,
  ScannerPort,
} from '../../../infrastructure/scanning/scanner.port';
import { newObjectKey } from '../../../infrastructure/storage/object-keys';
import {
  ObjectNotFound,
  type ObjectVersion,
  StoragePort,
} from '../../../infrastructure/storage/storage.port';
import { FileScans, type FileToScan } from './ports/file-scans.port';

/**
 * How many times a file's scan is tried: as often as the outbox delivers its
 * event (0.7.6). After the last, a scanner that never reached a verdict
 * leaves the file `FAILED` — never clean.
 */
export const SCAN_ATTEMPTS = DELIVERY.attempts;

/** A scan of one version: the verdict, and the hash and length of the bytes the scanner read. */
interface Scanned {
  readonly result: ScanResult;
  readonly sha256: Buffer;
  readonly length: number;
}

/**
 * The scan, then the promotion (0.8.4; SR-DOC-004, ADR-0009), for each file
 * whose upload completed (`file.uploaded`).
 *
 * The receipt marks the file `SCANNING`. After it commits, outside any
 * transaction, the file's **recorded quarantine version** — never the newest
 * — is streamed to the scanner while its SHA-256 is computed over the very
 * bytes the scanner reads. Clean: that **same version** is copied, inside the
 * store, to a new immutable key under `objects/`; then, the file locked and
 * still `SCANNING`, its copy's key, version and hash are recorded and it
 * becomes `READY` and `CLEAN`; then the quarantined version is deleted.
 * Infected: `REJECTED`, with the scanner's name for what it found; its bytes
 * stay in quarantine, which nothing serves. A scanner that does not answer —
 * or answers no verdict — is tried again with the outbox's back-off; after
 * the last try the file is `FAILED`, `ERROR`. Nothing ever marks a file clean
 * but a clean verdict on its pinned bytes.
 *
 * Because a download reads only the promoted version (0.8.5), a PUT replayed
 * through the upload's link — new quarantine bytes, at any time — changes
 * nothing anyone downloads. Each outcome is audited, as the system's job.
 */
@Injectable()
export class ScanFileConsumer extends OutboxConsumer {
  readonly name = 'files.scan';
  readonly types = ['file.uploaded'] as const;
  private readonly logger = new Logger('ScanFileConsumer');

  constructor(
    private readonly transactions: TenantTransactions,
    private readonly scans: FileScans,
    private readonly storage: StoragePort,
    private readonly scanner: ScannerPort,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    super();
  }

  async consume(
    tx: TenantTx,
    ctx: AuthorizedTenantContext,
    event: DeliveredEvent,
  ): Promise<string | undefined> {
    const file = await this.scans.lock(tx, ctx, event.payloadRefs.fileObjectId);
    if (file?.status !== 'UPLOADED') return undefined;
    await this.scans.startScan(tx, ctx, file.id);
    return file.id;
  }

  async dispatch(
    ctx: AuthorizedTenantContext,
    event: DeliveredEvent,
  ): Promise<void> {
    const fileId = event.payloadRefs.fileObjectId;
    const file = await this.transactions.withTenantTransaction(ctx, (tx) =>
      this.scans.find(tx, ctx, fileId),
    );
    if (file === null) return;
    // Promoted by an earlier delivery: only its quarantined bytes may be left.
    if (file.status === 'READY') return this.retireQuarantine(file);
    // Ended, or never scanned: nothing to do.
    if (file.status !== 'SCANNING' || file.quarantineVersionId === null) {
      return;
    }
    const pinned = {
      key: file.quarantineKey,
      versionId: file.quarantineVersionId,
    };
    const attempt = await this.transactions.withTenantTransaction(ctx, (tx) =>
      this.scans.countAttempt(tx, ctx, file.id),
    );
    let scanned: Scanned;
    try {
      scanned = await this.scanVersion(pinned);
      if (scanned.length !== file.sizeBytes) {
        throw new ScanNotCompleted('scan_length_mismatch');
      }
    } catch (error) {
      return this.notCompleted(ctx, file, attempt, error);
    }

    if (scanned.result.verdict === 'INFECTED') {
      return this.reject(ctx, file, scanned.result.finding);
    }
    await this.promote(ctx, file, pinned, scanned.sha256);
  }

  /**
   * The version's every byte, to the scanner, with its SHA-256 and length
   * taken over the same bytes as they pass.
   */
  private async scanVersion(version: ObjectVersion): Promise<Scanned> {
    const source = await this.storage.openVersion(version);
    const hash = createHash('sha256');
    let length = 0;
    const tap = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        hash.update(chunk);
        length += chunk.length;
        done(null, chunk);
      },
    });
    source.on('error', (error) => tap.destroy(error));
    source.pipe(tap);
    const result = await this.scanner.scan(tap);
    return { result, sha256: hash.digest(), length };
  }

  /**
   * Clean: the scanned version, copied inside the store to an immutable
   * key; recorded with its hash if the file is still `SCANNING`; then the
   * quarantined version deleted. A copy the record does not take — the file
   * moved on, or the transaction failed — is deleted again.
   */
  private async promote(
    ctx: AuthorizedTenantContext,
    file: FileToScan,
    scanned: ObjectVersion,
    sha256: Buffer,
  ): Promise<void> {
    const copy = await this.storage.copy(scanned, newObjectKey(ctx, 'objects'));
    let recorded = false;
    try {
      recorded = await this.transactions.withTenantTransaction(
        ctx,
        async (tx) => {
          const current = await this.scans.lock(tx, ctx, file.id);
          if (current?.status !== 'SCANNING') return false;
          await this.scans.promote(
            tx,
            ctx,
            file.id,
            { objectKey: copy.key, objectVersionId: copy.versionId, sha256 },
            this.clock.now(),
          );
          await this.audit.record(tx, ctx, {
            action: 'file.promoted',
            entityId: file.id,
            before: {
              status: current.status,
              scanVerdict: current.scanVerdict,
            },
            after: {
              status: 'READY',
              scanVerdict: 'CLEAN',
              objectVersionId: copy.versionId,
              sha256: sha256.toString('hex'),
            },
          });
          return true;
        },
      );
    } finally {
      if (!recorded) {
        await this.storage.deleteVersion(copy).catch(() => undefined);
      }
    }
    if (!recorded) return;
    this.logger.log(`file ${file.id}: clean, promoted`);
    await this.retireQuarantine(file);
  }

  /** Infected: `REJECTED`, with the scanner's name for what it found. */
  private async reject(
    ctx: AuthorizedTenantContext,
    file: FileToScan,
    finding: string,
  ): Promise<void> {
    const rejected = await this.transactions.withTenantTransaction(
      ctx,
      async (tx) => {
        const current = await this.scans.lock(tx, ctx, file.id);
        if (current?.status !== 'SCANNING') return false;
        await this.scans.reject(tx, ctx, file.id, finding, this.clock.now());
        await this.audit.record(tx, ctx, {
          action: 'file.rejected',
          entityId: file.id,
          before: { status: current.status, scanVerdict: current.scanVerdict },
          after: {
            status: 'REJECTED',
            scanVerdict: 'INFECTED',
            scanFinding: finding,
          },
        });
        return true;
      },
    );
    if (rejected) this.logger.warn(`file ${file.id}: infected, rejected`);
  }

  /**
   * No verdict. A version the store no longer holds can never be scanned:
   * the file fails at once. Otherwise it is tried again, and after the last
   * try it fails; either way it is never clean.
   */
  private async notCompleted(
    ctx: AuthorizedTenantContext,
    file: FileToScan,
    attempt: number,
    error: unknown,
  ): Promise<void> {
    const code =
      error instanceof ObjectNotFound
        ? 'quarantine_version_missing'
        : errorCodeOf(error);
    if (!(error instanceof ObjectNotFound) && attempt < SCAN_ATTEMPTS) {
      this.logger.warn(
        `file ${file.id}: scan not completed (${code}), attempt ${attempt} of ${SCAN_ATTEMPTS}`,
      );
      throw error;
    }
    await this.transactions.withTenantTransaction(ctx, async (tx) => {
      const current = await this.scans.lock(tx, ctx, file.id);
      if (current?.status !== 'SCANNING') return;
      await this.scans.fail(tx, ctx, file.id, this.clock.now());
      await this.audit.record(tx, ctx, {
        action: 'file.scan_failed',
        entityId: file.id,
        before: { status: current.status, scanVerdict: current.scanVerdict },
        after: { status: 'FAILED', scanVerdict: 'ERROR' },
        reason: code,
      });
    });
    this.logger.error(`file ${file.id}: scan failed (${code}), no verdict`);
    throw new EffectFailedForGood(code);
  }

  /** The quarantined version a promoted file came from, deleted once it is no longer needed. */
  private async retireQuarantine(file: FileToScan): Promise<void> {
    if (file.quarantineVersionId === null) return;
    const pinned = {
      key: file.quarantineKey,
      versionId: file.quarantineVersionId,
    };
    if ((await this.storage.head(pinned.key, pinned.versionId)) === null)
      return;
    await this.storage.deleteVersion(pinned);
  }
}
