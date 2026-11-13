// Downloads (0.8.5; SR-DOC-002, ADR-0009): a file is read through its
// owner's policy, served only once READY and CLEAN, and through a presigned
// GET for the exact key and version the scan promoted (0.8.4) — never the
// newest at a key, never the quarantine — lasting a minute, saved as an
// attachment under its name. Through HTTP, as two tenants' members, against
// the stack's object store (the test bucket) and its ClamAV.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { Tenant, User } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { TenantTransactions } from '../../src/common/tenancy/tenant-transaction';
import { systemClock } from '../../src/common/time/clock';
import { AuditService } from '../../src/infrastructure/audit/audit.service';
import type { DeliveredEvent } from '../../src/infrastructure/outbox/outbox-consumers';
import { ClamAvScanner } from '../../src/infrastructure/scanning/clamav.adapter';
import { S3Storage } from '../../src/infrastructure/storage/s3-storage';
import { ScanFileConsumer } from '../../src/modules/files/application/scan-file.handler';
import { FileScanRepository } from '../../src/modules/files/infrastructure/repositories/file-scan.repository';
import { bootApp, type BootedApp } from '../harness/app';
import { seedFile } from '../harness/files';
import {
  asTenant,
  createMember,
  createPlayer,
  createTenant,
  runPrisma,
  testContext,
} from '../harness/fixtures';
import {
  type ObjectStoreSettings,
  s3SettingsOf,
  testStoreClient,
} from '../harness/object-store';
import { signedInAs } from '../harness/session';

const API = '/api/v1';

/** A PDF of `size` bytes: its signature, then filler. */
function pdf(size: number): Buffer {
  const head = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1');
  return Buffer.concat([head, randomBytes(size - head.length)]);
}

const sha256Of = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');

interface Download {
  fileId: string;
  fileName: string;
  type: string;
  sizeBytes: number;
  sha256: string;
  get: { method: 'GET'; url: string; expiresAt: string };
}

const dataOf = (body: unknown) => (body as { data: Download }).data;
const codeOf = (body: unknown) => (body as { code: string }).code;

describe('downloads', () => {
  let booted: BootedApp;
  let store: ObjectStoreSettings;
  let admin: S3Client;
  let storage: S3Storage;
  let scanner: ClamAvScanner;
  let tenants: [Tenant, Tenant];
  let scouts: [User, User];
  let colleague: User;
  let coach: User;
  let players: [string, string];

  beforeAll(async () => {
    const configured = inject('objectStore');
    const daemon = inject('scanner');
    // No store or scanner, no test: S3_*_TEST and CLAMAV_*_TEST, from the
    // local stack or CI.
    if (configured === null || daemon === null) {
      throw new TypeError(
        'the download tests need the object store and ClamAV: run `just up`, or set S3_*_TEST and CLAMAV_*_TEST',
      );
    }
    store = configured;
    admin = testStoreClient(store);
    storage = new S3Storage(s3SettingsOf(store));
    scanner = new ClamAvScanner(daemon);
    booted = await bootApp({ objectStore: store });
    tenants = [await createTenant(), await createTenant()];
    scouts = [
      await createMember(tenants[0], 'SCOUT'),
      await createMember(tenants[1], 'SCOUT'),
    ];
    // Another member who may read documents: not the uploader.
    colleague = await createMember(tenants[0], 'ADMIN');
    // A member who reads players but not documents.
    coach = await createMember(tenants[0], 'COACH');
    players = [
      (await createPlayer(tenants[0])).id,
      (await createPlayer(tenants[1])).id,
    ];
  });

  afterAll(async () => {
    admin?.destroy();
    storage?.onModuleDestroy();
    await booted?.app.close();
  });

  /** A member's download of a file: its answer. */
  async function download(member: User, fileId: string) {
    return booted.http
      .get(`${API}/files/${fileId}/download`)
      .set(await signedInAs(member));
  }

  /** A promoted PDF of `member`'s, for `player`, seeded as the scan leaves one. */
  function promoted(
    tenant: Tenant,
    member: User,
    player: string,
    extra: { fileName?: string; classification?: 'MEDICAL' } = {},
  ) {
    return seedFile({ client: admin, bucket: store.bucket }, tenant, member, {
      bytes: pdf(2048),
      owner: { kind: 'player-document', id: player },
      ...extra,
    });
  }

  /** A PDF uploaded through the API by `member`, completed: its file, and the upload's link. */
  async function uploaded(member: User, player: string, bytes: Buffer) {
    const started = await booted.http
      .post(`${API}/uploads`)
      .set(await signedInAs(member))
      .set('Idempotency-Key', randomUUID())
      .send({
        ownerKind: 'player-document',
        ownerId: player,
        fileName: 'تقرير اللاعب.pdf',
        type: 'application/pdf',
        sizeBytes: bytes.length,
      });
    expect(started.status).toBe(201);
    const upload = (
      started.body as {
        data: {
          id: string;
          fileId: string;
          put: { url: string; headers: Record<string, string> };
        };
      }
    ).data;
    const sent = await fetch(upload.put.url, {
      method: 'PUT',
      headers: upload.put.headers,
      body: new Uint8Array(bytes),
    });
    expect(sent.status).toBe(200);
    const completed = await booted.http
      .post(`${API}/uploads/${upload.id}/complete`)
      .set(await signedInAs(member))
      .set('Idempotency-Key', randomUUID());
    expect(completed.status).toBe(200);
    return { fileId: upload.fileId, put: upload.put };
  }

  /** The file's scan, delivered as the worker delivers it (0.8.4): through ClamAV, then promoted. */
  async function scanned(tenant: Tenant, fileId: string) {
    const ctx = testContext(tenant.id, 'outbox:deliver');
    const row = await asTenant(tenant.id, (tx) =>
      tx.outboxEvent.findFirstOrThrow({
        where: { type: 'file.uploaded', aggregateId: fileId },
        select: {
          id: true,
          aggregateType: true,
          aggregateId: true,
          payloadVersion: true,
          payloadRefs: true,
        },
      }),
    );
    const event: DeliveredEvent = {
      ...row,
      tenantId: tenant.id,
      type: 'file.uploaded',
      payloadRefs: row.payloadRefs as Record<string, string>,
    };
    const consumer = new ScanFileConsumer(
      new TenantTransactions(runPrisma()),
      new FileScanRepository(),
      storage,
      scanner,
      new AuditService(),
      systemClock,
    );
    await new TenantTransactions(runPrisma()).withTenantTransaction(ctx, (tx) =>
      consumer.consume(tx, ctx, event),
    );
    await consumer.dispatch(ctx, event);
    return asTenant(tenant.id, (tx) =>
      tx.fileObject.findUniqueOrThrow({
        where: { id: fileId },
        select: {
          status: true,
          objectKey: true,
          objectVersionId: true,
          sha256: true,
        },
      }),
    );
  }

  /** The access events of a file. */
  function accessEventsOf(tenant: Tenant, fileId: string) {
    return asTenant(tenant.id, (tx) =>
      tx.auditLog.findMany({
        where: { entityId: fileId, action: 'file.read' },
        select: { userId: true, newValues: true },
      }),
    );
  }

  it('a_download_is_pinned_to_the_scanned_version', async () => {
    const [a] = tenants;
    const [scout] = scouts;
    const bytes = pdf(4096);
    const file = await uploaded(scout, players[0], bytes);
    const row = await scanned(a, file.fileId);
    expect(row.status).toBe('READY');

    // After the scan, the store is written to again: the upload's link,
    // still valid, replayed with other bytes of the same size, and a new
    // version put at the promoted key itself.
    const replayed = await fetch(file.put.url, {
      method: 'PUT',
      headers: file.put.headers,
      body: new Uint8Array(pdf(4096)),
    });
    expect(replayed.status).toBe(200);
    const overwritten = await admin.send(
      new PutObjectCommand({
        Bucket: store.bucket,
        Key: row.objectKey!,
        Body: pdf(4096),
        ContentType: 'application/pdf',
      }),
    );
    expect(overwritten.VersionId).not.toBe(row.objectVersionId);

    const answer = await download(scout, file.fileId);
    expect(answer.status).toBe(200);
    expect(answer.headers['cache-control']).toBe('no-store');
    const released = dataOf(answer.body);
    expect(released).toMatchObject({
      fileId: file.fileId,
      fileName: 'تقرير اللاعب.pdf',
      type: 'application/pdf',
      sizeBytes: bytes.length,
      sha256: sha256Of(bytes),
    });
    // The link names the promoted key and its exact version.
    const link = new URL(released.get.url);
    expect(link.pathname.endsWith(`/${row.objectKey}`)).toBe(true);
    expect(link.searchParams.get('versionId')).toBe(row.objectVersionId);
    expect(link.pathname).not.toContain('/quarantine/');

    // What the link serves is what was scanned: neither the replay nor the
    // newer version.
    const fetched = await fetch(released.get.url);
    expect(fetched.status).toBe(200);
    const served = Buffer.from(await fetched.arrayBuffer());
    expect(served.equals(bytes)).toBe(true);
    expect(sha256Of(served)).toBe(Buffer.from(row.sha256!).toString('hex'));
    // Saved as an attachment, under its name in UTF-8.
    const name = 'تقرير اللاعب.pdf';
    const fallback = [...name]
      .map((c) => (/^[\x20-\x7e]$/.test(c) ? c : '_'))
      .join('');
    expect(fetched.headers.get('content-disposition')).toBe(
      `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    );
    // An operational file leaves no access event.
    expect(await accessEventsOf(a, file.fileId)).toEqual([]);
  });

  it('a_download_for_another_tenant_is_not_found', async () => {
    const [a, b] = tenants;
    const [scoutA, scoutB] = scouts;
    const file = await promoted(a, scoutA, players[0]);
    const theirs = await promoted(b, scoutB, players[1]);

    // B's scout, who may read documents, names A's file: not found.
    const refused = await download(scoutB, file.fileId);
    expect(refused.status).toBe(404);
    expect(codeOf(refused.body)).toBe('NOT_FOUND');
    expect(JSON.stringify(refused.body)).not.toContain(file.objectKey!);
    // An id no file has: the same answer.
    const none = await download(scoutB, randomUUID());
    expect(none.status).toBe(404);
    expect(codeOf(none.body)).toBe('NOT_FOUND');

    // Each, in their own tenant, downloads their own.
    expect((await download(scoutA, file.fileId)).status).toBe(200);
    expect((await download(scoutB, theirs.fileId)).status).toBe(200);
  });

  it('an_unscanned_file_cannot_be_downloaded', async () => {
    const [a] = tenants;
    const [scout] = scouts;
    // Completed, its scan not yet run.
    const pending = await uploaded(scout, players[0], pdf(1024));
    const waiting = await download(scout, pending.fileId);
    expect(waiting.status).toBe(409);
    expect(codeOf(waiting.body)).toBe('FILE_UNAVAILABLE');
    expect(waiting.body).not.toHaveProperty('data');

    // Refused by its scan, or never scanned: nothing serves either.
    for (const outcome of ['infected', 'failed'] as const) {
      const ended = await seedFile(
        { client: admin, bucket: store.bucket },
        a,
        scout,
        {
          bytes: pdf(1024),
          owner: { kind: 'player-document', id: players[0] },
          outcome,
        },
      );
      const answer = await download(scout, ended.fileId);
      expect([outcome, answer.status]).toEqual([outcome, 409]);
      expect(codeOf(answer.body)).toBe('FILE_UNAVAILABLE');
    }

    // Once scanned clean, the same file downloads.
    await scanned(a, pending.fileId);
    expect((await download(scout, pending.fileId)).status).toBe(200);
  });

  it('a_purged_file_cannot_be_downloaded', async () => {
    const [a] = tenants;
    const file = await promoted(a, scouts[0], players[0]);
    expect((await download(scouts[0], file.fileId)).status).toBe(200);
    // Purged under an approved policy (1.3.4): its bytes are not to be served.
    await asTenant(a.id, (tx) =>
      tx.fileObject.update({
        where: { id: file.fileId },
        data: { purgedAt: new Date() },
      }),
    );
    const answer = await download(scouts[0], file.fileId);
    expect(answer.status).toBe(409);
    expect(codeOf(answer.body)).toBe('FILE_UNAVAILABLE');
  });

  it('a_member_who_may_read_documents_downloads_another_members_file', async () => {
    const [a] = tenants;
    const file = await promoted(a, scouts[0], players[0]);
    const answer = await download(colleague, file.fileId);
    expect(answer.status).toBe(200);
    expect(dataOf(answer.body).fileId).toBe(file.fileId);
  });

  it('a_role_without_document_read_cannot_download', async () => {
    const [a] = tenants;
    const file = await promoted(a, scouts[0], players[0]);
    const refused = await download(coach, file.fileId);
    expect(refused.status).toBe(403);
    expect(codeOf(refused.body)).toBe('FORBIDDEN');
  });

  it('a_download_link_lasts_a_minute', async () => {
    const [a] = tenants;
    const file = await promoted(a, scouts[0], players[0]);
    const before = Date.now();
    const answer = await download(scouts[0], file.fileId);
    const after = Date.now();
    const { get } = dataOf(answer.body);
    expect(get.method).toBe('GET');
    const expiresAt = new Date(get.expiresAt).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + 59_000);
    expect(expiresAt).toBeLessThanOrEqual(after + 61_000);
    expect(new URL(get.url).searchParams.get('X-Amz-Expires')).toBe('60');
  });

  it('a_long_name_is_saved_whole_with_its_extension', async () => {
    const [a] = tenants;
    const fileName = `${'ملف '.repeat(60)}النهائي.pdf`;
    const file = await promoted(a, scouts[0], players[0], { fileName });
    const answer = await download(scouts[0], file.fileId);
    expect(dataOf(answer.body).fileName).toBe(fileName);
    const fetched = await fetch(dataOf(answer.body).get.url);
    expect(fetched.status).toBe(200);
    const saved = decodeURIComponent(
      /filename\*=UTF-8''(.*)$/.exec(
        fetched.headers.get('content-disposition') ?? '',
      )![1],
    );
    expect([...saved]).toHaveLength(150);
    expect(saved.endsWith('.pdf')).toBe(true);
  });

  it('a_confidential_file_no_policy_discloses_is_not_found', async () => {
    const [a] = tenants;
    const owner = await createMember(a, 'OWNER');
    const file = await promoted(a, scouts[0], players[0], {
      classification: 'MEDICAL',
    });
    // No player-document policy discloses MEDICAL yet (1.3.1): as absent.
    for (const reader of [owner, scouts[0], colleague]) {
      const answer = await download(reader, file.fileId);
      expect([reader.role, answer.status]).toEqual([reader.role, 404]);
    }
    expect(await accessEventsOf(a, file.fileId)).toEqual([]);
  });

  it('a_file_whose_owner_is_unknown_is_not_found', async () => {
    const [a] = tenants;
    for (const owner of [
      // A kind no code knows.
      { kind: 'contract-document', id: players[0] },
      // A player that is not there.
      { kind: 'player-document', id: randomUUID() },
    ]) {
      const file = await seedFile(
        { client: admin, bucket: store.bucket },
        a,
        scouts[0],
        { bytes: pdf(1024), owner },
      );
      const answer = await download(scouts[0], file.fileId);
      expect([owner.kind, answer.status]).toEqual([owner.kind, 404]);
    }
  });
});
