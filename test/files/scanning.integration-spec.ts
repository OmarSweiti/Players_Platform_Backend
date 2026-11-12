// The scan and the promotion (0.8.4; SR-DOC-004, ADR-0009): a completed
// upload's pinned quarantine version is streamed to ClamAV — the stack's
// daemon — while its SHA-256 is taken; a clean file is copied, that same
// version, to an immutable key and becomes READY; an infected one is
// REJECTED; a scanner that never answers leaves the file FAILED, never clean.
// As the runtime role, in two tenants, against the stack's object store, with
// the EICAR test file.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Readable } from 'node:stream';
import type { Tenant, User } from '@prisma/client';
import type { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { AuthorizedTenantContext } from '../../src/common/tenancy/tenant-context';
import { TenantTransactions } from '../../src/common/tenancy/tenant-transaction';
import { systemClock } from '../../src/common/time/clock';
import { AuditService } from '../../src/infrastructure/audit/audit.service';
import { ConsumerInboxes } from '../../src/infrastructure/outbox/consumer-inboxes';
import { Outbox } from '../../src/infrastructure/outbox/outbox';
import type { DeliveredEvent } from '../../src/infrastructure/outbox/outbox-consumers';
import { EffectFailedForGood } from '../../src/infrastructure/outbox/outbox-consumers';
import { OutboxJobHandler } from '../../src/infrastructure/queue/outbox-worker';
import { ClamAvScanner } from '../../src/infrastructure/scanning/clamav.adapter';
import {
  type ScannerPort,
  ScanNotCompleted,
} from '../../src/infrastructure/scanning/scanner.port';
import type { ObjectKey } from '../../src/infrastructure/storage/object-keys';
import { S3Storage } from '../../src/infrastructure/storage/s3-storage';
import {
  type ObjectHead,
  type ObjectVersion,
  type PresignedRequest,
  StoragePort,
} from '../../src/infrastructure/storage/storage.port';
import {
  SCAN_ATTEMPTS,
  ScanFileConsumer,
} from '../../src/modules/files/application/scan-file.handler';
import { FileScanRepository } from '../../src/modules/files/infrastructure/repositories/file-scan.repository';
import {
  asTenant,
  createMember,
  createPlayer,
  createTenant,
  runPrisma,
  testContext,
} from '../harness/fixtures';
import { s3SettingsOf } from '../harness/object-store';

/**
 * The EICAR test file: not a virus, the string every scanner is built to
 * report as one. Kept encoded, so this source file is never itself flagged.
 */
const EICAR = Buffer.from(
  'WDVPIVAlQEFQWzRcUFpYNTQoUF4pN0NDKTd9JEVJQ0FSLVNUQU5EQVJELUFOVElWSVJVUy1URVNULUZJTEUhJEgrSCo=',
  'base64',
);

/** A PDF's bytes: its signature, then filler. */
function pdf(size = 4096): Buffer {
  const head = Buffer.from('%PDF-1.7\n', 'latin1');
  return Buffer.concat([head, randomBytes(size - head.length)]);
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest();

/** Every byte of a stream. */
async function bytesOf(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** The storage port, its copy held at a gate the test opens: the moment between the scan and the copy. */
class GatedStorage extends StoragePort {
  private open!: () => void;
  readonly opened = new Promise<void>((resolve) => (this.open = resolve));
  private reach!: () => void;
  readonly reached = new Promise<void>((resolve) => (this.reach = resolve));

  constructor(private readonly inner: StoragePort) {
    super();
  }
  release(): void {
    this.open();
  }
  presignPut(
    key: ObjectKey,
    options: {
      contentType: string;
      contentLength: number;
      expiresInSeconds: number;
    },
  ): Promise<PresignedRequest> {
    return this.inner.presignPut(key, options);
  }
  presignGet(
    version: ObjectVersion,
    options: { expiresInSeconds: number; downloadName?: string },
  ): Promise<PresignedRequest> {
    return this.inner.presignGet(version, options);
  }
  head(key: ObjectKey, versionId?: string): Promise<ObjectHead | null> {
    return this.inner.head(key, versionId);
  }
  readRange(
    version: ObjectVersion,
    start: number,
    end: number,
  ): Promise<Buffer> {
    return this.inner.readRange(version, start, end);
  }
  openVersion(version: ObjectVersion): Promise<Readable> {
    return this.inner.openVersion(version);
  }
  async copy(from: ObjectVersion, to: ObjectKey): Promise<ObjectVersion> {
    this.reach();
    await this.opened;
    return this.inner.copy(from, to);
  }
  deleteVersion(version: ObjectVersion): Promise<void> {
    return this.inner.deleteVersion(version);
  }
}

/** A port on this machine nothing listens on: a scanner that is down. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

interface Uploaded {
  readonly fileId: string;
  readonly key: ObjectKey;
  /** The version completion pinned. */
  readonly versionId: string;
  /** The upload's link, still valid: what a replay sends through. */
  readonly put: PresignedRequest;
  readonly bytes: Buffer;
  readonly event: DeliveredEvent;
  readonly ctx: AuthorizedTenantContext;
}

describe('the scan and the promotion', () => {
  let storage: S3Storage;
  let scanner: ScannerPort;
  let tenants: [Tenant, Tenant];
  let members: [User, User];
  let players: [string, string];
  const outbox = new Outbox();

  beforeAll(async () => {
    const store = inject('objectStore');
    const daemon = inject('scanner');
    // No store or scanner, no test: S3_*_TEST and CLAMAV_*_TEST, from the
    // local stack or CI.
    if (store === null || daemon === null) {
      throw new TypeError(
        'the scan tests need the object store and ClamAV: run `just up`, or set S3_*_TEST and CLAMAV_*_TEST',
      );
    }
    storage = new S3Storage(s3SettingsOf(store));
    scanner = new ClamAvScanner(daemon);
    tenants = [await createTenant(), await createTenant()];
    members = [
      await createMember(tenants[0], 'SCOUT'),
      await createMember(tenants[1], 'SCOUT'),
    ];
    players = [
      (await createPlayer(tenants[0])).id,
      (await createPlayer(tenants[1])).id,
    ];
  });

  afterAll(() => {
    storage?.onModuleDestroy();
  });

  /** The consumer, as the worker composes it, over `store` and `daemon`. */
  function consumerWith(
    store: StoragePort = storage,
    daemon: ScannerPort = scanner,
  ): ScanFileConsumer {
    return new ScanFileConsumer(
      new TenantTransactions(runPrisma()),
      new FileScanRepository(),
      store,
      daemon,
      new AuditService(),
      systemClock,
    );
  }

  /**
   * A file whose upload completed, as 0.8.3 leaves it: sent through its
   * presigned link, its version pinned, `UPLOADED`, and its `file.uploaded`
   * event enqueued — in `tenant`, by `member`.
   */
  async function uploaded(
    tenant: Tenant,
    member: User,
    player: string,
    bytes: Buffer,
  ): Promise<Uploaded> {
    const ctx = testContext(tenant.id, 'outbox:deliver');
    const key = `tenants/${tenant.id}/quarantine/${randomUUID()}` as ObjectKey;
    const put = await storage.presignPut(key, {
      contentType: 'application/pdf',
      contentLength: bytes.length,
      expiresInSeconds: 600,
    });
    const sent = await fetch(put.url, {
      method: 'PUT',
      headers: put.headers,
      body: new Uint8Array(bytes),
    });
    expect(sent.status).toBe(200);
    const versionId = sent.headers.get('x-amz-version-id')!;
    const { fileId, eventId } = await asTenant(tenant.id, async (tx) => {
      const file = await tx.fileObject.create({
        data: {
          tenantId: tenant.id,
          quarantineKey: key,
          quarantineVersionId: versionId,
          sizeBytes: BigInt(bytes.length),
          mimeType: 'application/pdf',
          originalName: 'contract.pdf',
          status: 'UPLOADED',
          classification: 'OPERATIONAL',
          createdById: member.id,
        },
      });
      await tx.uploadSession.create({
        data: {
          tenantId: tenant.id,
          fileObjectId: file.id,
          createdById: member.id,
          declaredSize: BigInt(bytes.length),
          declaredType: 'application/pdf',
          ownerKind: 'player-document',
          ownerId: player,
          expiresAt: new Date(Date.now() + 3_600_000),
          finalizedAt: new Date(),
        },
      });
      const event = await outbox.enqueue(tx, ctx, {
        type: 'file.uploaded',
        aggregateId: file.id,
        refs: { fileObjectId: file.id },
        dedupKey: `file.uploaded:${file.id}`,
      });
      return { fileId: file.id, eventId: event.id };
    });
    return {
      fileId,
      key,
      versionId,
      put,
      bytes,
      ctx,
      event: {
        id: eventId,
        tenantId: tenant.id,
        type: 'file.uploaded',
        aggregateType: 'FileObject',
        aggregateId: fileId,
        payloadVersion: 1,
        payloadRefs: { fileObjectId: fileId },
      },
    };
  }

  /** The receipt's effect, in its tenant transaction, then the call after it — as the worker runs them. */
  async function deliver(consumer: ScanFileConsumer, file: Uploaded) {
    await new TenantTransactions(runPrisma()).withTenantTransaction(
      file.ctx,
      (tx) => consumer.consume(tx, file.ctx, file.event),
    );
    await consumer.dispatch(file.ctx, file.event);
  }

  function rowOf(tenant: Tenant, fileId: string) {
    return asTenant(tenant.id, (tx) =>
      tx.fileObject.findUniqueOrThrow({
        where: { id: fileId },
        select: {
          status: true,
          scanVerdict: true,
          scanAttempts: true,
          scannedAt: true,
          scanFinding: true,
          quarantineVersionId: true,
          objectKey: true,
          objectVersionId: true,
          sha256: true,
          finalizedAt: true,
        },
      }),
    );
  }

  function auditsOf(tenant: Tenant, fileId: string) {
    return asTenant(tenant.id, (tx) =>
      tx.auditLog.findMany({
        where: { entityId: fileId },
        orderBy: { createdAt: 'asc' },
        select: {
          action: true,
          actorType: true,
          actorJob: true,
          newValues: true,
          reason: true,
        },
      }),
    );
  }

  /** The promoted object's bytes, read at the version the file records. */
  async function promotedBytes(row: {
    objectKey: string | null;
    objectVersionId: string | null;
  }) {
    return bytesOf(
      await storage.openVersion({
        key: row.objectKey as ObjectKey,
        versionId: row.objectVersionId!,
      }),
    );
  }

  it('a_clean_file_is_promoted_to_an_immutable_version', async () => {
    const [a] = tenants;
    const file = await uploaded(a, members[0], players[0], pdf());
    await deliver(consumerWith(), file);

    const row = await rowOf(a, file.fileId);
    expect(row).toMatchObject({
      status: 'READY',
      scanVerdict: 'CLEAN',
      scanAttempts: 1,
      scanFinding: null,
      quarantineVersionId: file.versionId,
    });
    expect(row.scannedAt).toBeInstanceOf(Date);
    expect(row.finalizedAt).toEqual(row.scannedAt);
    // Its own immutable key, in its tenant's objects, the hash of its bytes.
    expect(row.objectKey).toMatch(
      new RegExp(`^tenants/${a.id}/objects/[0-9a-f-]{36}$`),
    );
    expect(Buffer.from(row.sha256!).equals(sha256(file.bytes))).toBe(true);
    expect((await promotedBytes(row)).equals(file.bytes)).toBe(true);
    // The quarantined version is gone; the promoted one is all that is read.
    expect(await storage.head(file.key, file.versionId)).toBeNull();

    // Audited as the system's job, the version and the hash recorded.
    const audits = await auditsOf(a, file.fileId);
    expect(audits).toEqual([
      expect.objectContaining({
        action: 'file.promoted',
        actorType: 'SYSTEM',
        actorJob: 'outbox:deliver',
        newValues: {
          status: 'READY',
          scanVerdict: 'CLEAN',
          objectVersionId: row.objectVersionId,
          sha256: sha256(file.bytes).toString('hex'),
        },
      }),
    ]);
  });

  it('an_infected_file_is_rejected', async () => {
    const [a] = tenants;
    const file = await uploaded(a, members[0], players[0], EICAR);
    await deliver(consumerWith(), file);

    const row = await rowOf(a, file.fileId);
    expect(row).toMatchObject({
      status: 'REJECTED',
      scanVerdict: 'INFECTED',
      objectKey: null,
      objectVersionId: null,
      sha256: null,
      finalizedAt: null,
    });
    // ClamAV's own name for what it found.
    expect(row.scanFinding).toMatch(/eicar/i);
    expect(row.scannedAt).toBeInstanceOf(Date);
    // Nothing promoted; its bytes stay in quarantine, which nothing serves.
    expect(await storage.head(file.key, file.versionId)).not.toBeNull();
    expect(
      (await auditsOf(a, file.fileId)).map(({ action }) => action),
    ).toEqual(['file.rejected']);
  });

  it('replaying_the_upload_url_after_promotion_changes_nothing', async () => {
    const [a] = tenants;
    const file = await uploaded(a, members[0], players[0], pdf());
    await deliver(consumerWith(), file);
    const before = await rowOf(a, file.fileId);
    expect(before.status).toBe('READY');

    // The upload's link is still valid: a replay sends other bytes — the
    // EICAR file, as an attacker would — to the quarantine key.
    const replay = await fetch(file.put.url, {
      method: 'PUT',
      headers: file.put.headers,
      body: new Uint8Array(
        Buffer.concat([
          EICAR,
          Buffer.alloc(file.bytes.length - EICAR.length, 0x20),
        ]),
      ),
    });
    expect(replay.status).toBe(200);
    // The event delivered again, as a worker that crashed would.
    await consumerWith().dispatch(file.ctx, file.event);

    const after = await rowOf(a, file.fileId);
    expect(after).toEqual(before);
    expect((await promotedBytes(after)).equals(file.bytes)).toBe(true);
  });

  it('a_replay_between_scan_and_copy_cannot_promote_unscanned_bytes', async () => {
    const [a] = tenants;
    const file = await uploaded(a, members[0], players[0], pdf());
    const gated = new GatedStorage(storage);
    const delivery = deliver(consumerWith(gated), file);
    // Scanned clean, and stopped before the copy.
    await gated.reached;
    expect((await rowOf(a, file.fileId)).status).toBe('SCANNING');
    // Then, through the old link, other bytes: a new version at the key.
    const swapped = Buffer.concat([
      EICAR,
      Buffer.alloc(file.bytes.length - EICAR.length, 0x20),
    ]);
    const replay = await fetch(file.put.url, {
      method: 'PUT',
      headers: file.put.headers,
      body: new Uint8Array(swapped),
    });
    expect(replay.status).toBe(200);
    const replayed = replay.headers.get('x-amz-version-id');
    expect(replayed).not.toBe(file.versionId);
    gated.release();
    await delivery;

    // What was promoted is what was scanned: the pinned version, its hash.
    const row = await rowOf(a, file.fileId);
    expect(row).toMatchObject({ status: 'READY', scanVerdict: 'CLEAN' });
    const promoted = await promotedBytes(row);
    expect(promoted.equals(file.bytes)).toBe(true);
    expect(promoted.equals(swapped)).toBe(false);
    expect(Buffer.from(row.sha256!).equals(sha256(file.bytes))).toBe(true);
    // The replayed bytes stay in quarantine, unscanned and never served.
    expect(await storage.head(file.key, replayed!)).not.toBeNull();
  });

  it('a_replay_before_the_scan_is_neither_scanned_nor_promoted', async () => {
    const [a] = tenants;
    const file = await uploaded(a, members[0], players[0], pdf());
    // Completed and pinned; then, before the worker reaches it, the old link
    // sends the EICAR file, padded to the declared size: the newest version.
    const swapped = Buffer.concat([
      EICAR,
      Buffer.alloc(file.bytes.length - EICAR.length, 0x20),
    ]);
    const replay = await fetch(file.put.url, {
      method: 'PUT',
      headers: file.put.headers,
      body: new Uint8Array(swapped),
    });
    expect(replay.status).toBe(200);
    await deliver(consumerWith(), file);

    // The pinned version was scanned — clean — and promoted; the newest never.
    const row = await rowOf(a, file.fileId);
    expect(row).toMatchObject({ status: 'READY', scanVerdict: 'CLEAN' });
    expect((await promotedBytes(row)).equals(file.bytes)).toBe(true);
    expect(Buffer.from(row.sha256!).equals(sha256(file.bytes))).toBe(true);
  });

  it('a_scanner_outage_never_marks_a_file_clean', async () => {
    const [a] = tenants;
    const file = await uploaded(a, members[0], players[0], pdf());
    const down = consumerWith(
      storage,
      new ClamAvScanner({ host: '127.0.0.1', port: await closedPort() }),
    );
    await new TenantTransactions(runPrisma()).withTenantTransaction(
      file.ctx,
      (tx) => down.consume(tx, file.ctx, file.event),
    );
    // Each delivery but the last: no verdict, tried again, never clean.
    for (let attempt = 1; attempt < SCAN_ATTEMPTS; attempt++) {
      await expect(down.dispatch(file.ctx, file.event)).rejects.toBeInstanceOf(
        ScanNotCompleted,
      );
      expect(await rowOf(a, file.fileId)).toMatchObject({
        status: 'SCANNING',
        scanVerdict: 'PENDING',
        scanAttempts: attempt,
        scannedAt: null,
        objectKey: null,
      });
    }
    // The last: the file fails, its verdict an error — and the event is
    // dead, its code the scanner's.
    await expect(down.dispatch(file.ctx, file.event)).rejects.toEqual(
      new EffectFailedForGood('econnrefused'),
    );
    const row = await rowOf(a, file.fileId);
    expect(row).toMatchObject({
      status: 'FAILED',
      scanVerdict: 'ERROR',
      scanAttempts: SCAN_ATTEMPTS,
      objectKey: null,
      sha256: null,
    });
    expect(row.scannedAt).toBeInstanceOf(Date);
    expect(await auditsOf(a, file.fileId)).toEqual([
      expect.objectContaining({
        action: 'file.scan_failed',
        reason: 'econnrefused',
        newValues: { status: 'FAILED', scanVerdict: 'ERROR' },
      }),
    ]);
    // Once failed, a scanner back again changes nothing.
    await consumerWith().dispatch(file.ctx, file.event);
    expect((await rowOf(a, file.fileId)).status).toBe('FAILED');
  });

  it('a_redelivered_event_promotes_once', async () => {
    const [a] = tenants;
    const file = await uploaded(a, members[0], players[0], pdf());
    const consumer = consumerWith();
    await deliver(consumer, file);
    const first = await rowOf(a, file.fileId);
    await deliver(consumer, file);
    expect(await rowOf(a, file.fileId)).toEqual(first);
    expect(
      (await auditsOf(a, file.fileId)).map(({ action }) => action),
    ).toEqual(['file.promoted']);
  });

  it('the_worker_scans_a_completed_upload_through_its_job', async () => {
    const [a] = tenants;
    const file = await uploaded(a, members[0], players[0], pdf());
    const handler = new OutboxJobHandler(
      runPrisma(),
      new ConsumerInboxes(),
      [consumerWith()],
      { runInContext: (fn: () => unknown) => fn() } as never,
    );
    const job = {
      id: file.event.id,
      data: {
        tenantId: a.id,
        eventId: file.event.id,
        correlation: { requestId: null },
      },
    } as unknown as Job;
    await expect(handler.handle(job)).resolves.toBe(1);
    expect((await rowOf(a, file.fileId)).status).toBe('READY');
    const receipts = await asTenant(a.id, (tx) =>
      tx.consumerInbox.findMany({
        where: { eventId: file.event.id },
        select: { consumer: true, resultRef: true },
      }),
    );
    expect(receipts).toEqual([
      { consumer: 'files.scan', resultRef: file.fileId },
    ]);
  });

  it('a_pinned_version_the_store_no_longer_holds_fails_the_file_at_once', async () => {
    const [a] = tenants;
    const file = await uploaded(a, members[0], players[0], pdf());
    await storage.deleteVersion({ key: file.key, versionId: file.versionId });
    const consumer = consumerWith();
    await new TenantTransactions(runPrisma()).withTenantTransaction(
      file.ctx,
      (tx) => consumer.consume(tx, file.ctx, file.event),
    );
    await expect(consumer.dispatch(file.ctx, file.event)).rejects.toEqual(
      new EffectFailedForGood('quarantine_version_missing'),
    );
    expect(await rowOf(a, file.fileId)).toMatchObject({
      status: 'FAILED',
      scanVerdict: 'ERROR',
      scanAttempts: 1,
    });
  });

  it('a_scan_runs_only_in_its_files_tenant', async () => {
    const [a, b] = tenants;
    const file = await uploaded(b, members[1], players[1], pdf());
    // The event, delivered as tenant A's: B's file is not there to see.
    const astray = { ...file, ctx: testContext(a.id, 'outbox:deliver') };
    await deliver(consumerWith(), astray);
    expect(await rowOf(b, file.fileId)).toMatchObject({
      status: 'UPLOADED',
      scanVerdict: 'PENDING',
      scanAttempts: 0,
    });
    // In its own tenant, it is scanned.
    await deliver(consumerWith(), file);
    expect((await rowOf(b, file.fileId)).status).toBe('READY');
  });

  // Quiet: the consumer's outcome lines are for the worker's log.
  beforeAll(() => {
    Logger.overrideLogger(['error']);
  });
});
