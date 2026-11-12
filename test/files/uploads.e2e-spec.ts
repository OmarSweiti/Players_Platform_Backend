// Uploads (0.8.3; SR-DOC-003, SR-NFR-PERF-002): an upload starts with a
// presigned PUT into quarantine, bound to the declared type and size; its
// completion pins the exact version that arrived, once its size, type and
// first bytes match the declaration, and queues its scan. Through HTTP, as
// two tenants' members, against the stack's object store (the test bucket).
import { randomBytes, randomUUID } from 'node:crypto';
import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { Tenant, User } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { bootApp, type BootedApp } from '../harness/app';
import {
  asTenant,
  createMember,
  createPlayer,
  createTenant,
} from '../harness/fixtures';
import {
  type ObjectStoreSettings,
  testStoreClient,
} from '../harness/object-store';
import { signedInAs } from '../harness/session';

const API = '/api/v1';

/** A PDF of `size` bytes: its signature, then filler. */
function pdf(size: number): Buffer {
  const head = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1');
  return Buffer.concat([head, randomBytes(size - head.length)]);
}

/** A Windows executable's bytes — "MZ" and its header — of `size` bytes. */
function executable(size: number): Buffer {
  const head = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
  return Buffer.concat([head, randomBytes(size - head.length)]);
}

interface Put {
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
}

interface Upload {
  id: string;
  fileId: string;
  status: string;
  ownerKind: string;
  ownerId: string;
  fileName: string;
  type: string;
  sizeBytes: number;
  createdAt: string;
  expiresAt: string;
  completedAt: string | null;
  put: Put | null;
}

const dataOf = (body: unknown) => (body as { data: Upload }).data;
const codeOf = (body: unknown) => (body as { code: string }).code;

describe('uploads', () => {
  let booted: BootedApp;
  let store: ObjectStoreSettings;
  let admin: S3Client;
  let tenants: [Tenant, Tenant];
  let scouts: [User, User];
  let otherScout: User;
  let players: [string, string];

  beforeAll(async () => {
    const configured = inject('objectStore');
    // No store, no test: S3_*_TEST, from the local stack or CI.
    if (configured === null) {
      throw new TypeError(
        'the upload tests need the object store: run `just up`, or set S3_*_TEST',
      );
    }
    store = configured;
    admin = testStoreClient(store);
    booted = await bootApp({ objectStore: store });
    tenants = [await createTenant(), await createTenant()];
    scouts = [
      await createMember(tenants[0], 'SCOUT'),
      await createMember(tenants[1], 'SCOUT'),
    ];
    otherScout = await createMember(tenants[0], 'SCOUT');
    players = [
      (await createPlayer(tenants[0])).id,
      (await createPlayer(tenants[1])).id,
    ];
  });

  afterAll(async () => {
    admin?.destroy();
    await booted?.app.close();
  });

  /** A member's request to start an upload: its answer. */
  async function start(
    member: User,
    body: Record<string, unknown>,
    key: string = randomUUID(),
  ) {
    return booted.http
      .post(`${API}/uploads`)
      .set(await signedInAs(member))
      .set('Idempotency-Key', key)
      .send(body);
  }

  /** A member's completion of an upload: its answer. */
  async function complete(member: User, id: string, key = randomUUID()) {
    return booted.http
      .post(`${API}/uploads/${id}/complete`)
      .set(await signedInAs(member))
      .set('Idempotency-Key', key);
  }

  /** A PDF upload for `player` of `size` bytes, started: the upload and its link. */
  async function started(
    member: User,
    player: string,
    size: number,
    fileName = 'contract.pdf',
  ): Promise<Upload & { put: Put }> {
    const answer = await start(member, {
      ownerKind: 'player-document',
      ownerId: player,
      fileName,
      type: 'application/pdf',
      sizeBytes: size,
    });
    expect(answer.status).toBe(201);
    const upload = dataOf(answer.body);
    expect(upload.put).not.toBeNull();
    return upload as Upload & { put: Put };
  }

  /** The file sent through the upload's link, as a browser sends it. */
  async function send(put: Put, body: Buffer) {
    const answer = await fetch(put.url, {
      method: put.method,
      headers: put.headers,
      body: new Uint8Array(body),
    });
    return {
      status: answer.status,
      versionId: answer.headers.get('x-amz-version-id'),
    };
  }

  /** The upload's rows, as the runtime role reads them in its tenant. */
  function rowsOf(tenant: Tenant, upload: Upload) {
    return asTenant(tenant.id, async (tx) => ({
      file: await tx.fileObject.findUniqueOrThrow({
        where: { id: upload.fileId },
        select: {
          status: true,
          quarantineKey: true,
          quarantineVersionId: true,
          sizeBytes: true,
          mimeType: true,
          originalName: true,
          scanVerdict: true,
          classification: true,
        },
      }),
      session: await tx.uploadSession.findUniqueOrThrow({
        where: { id: upload.id },
        select: {
          finalizedAt: true,
          ownerKind: true,
          ownerId: true,
          declaredSize: true,
          declaredType: true,
          revision: true,
        },
      }),
      scans: await tx.outboxEvent.findMany({
        where: { type: 'file.uploaded', aggregateId: upload.fileId },
        select: { payloadRefs: true, dedupKey: true },
      }),
    }));
  }

  it('an_executable_renamed_pdf_is_refused', async () => {
    const [a] = tenants;
    const [scout] = scouts;
    const size = 4096;
    const upload = await started(scout, players[0], size, 'contract.pdf');
    // The store takes it: the declared type and size are all it can check.
    expect((await send(upload.put, executable(size))).status).toBe(200);

    const key = randomUUID();
    const refused = await complete(scout, upload.id, key);
    expect(refused.status).toBe(422);
    expect(codeOf(refused.body)).toBe('UPLOAD_CONTENT_MISMATCH');
    // Nothing pinned, nothing queued: the file stays in quarantine, unread.
    const rows = await rowsOf(a, upload);
    expect(rows.file).toMatchObject({
      status: 'UPLOADING',
      quarantineVersionId: null,
      scanVerdict: 'PENDING',
    });
    expect(rows.session.finalizedAt).toBeNull();
    expect(rows.scans).toEqual([]);
    // A retry with the same key is answered as the first was.
    const again = await complete(scout, upload.id, key);
    expect([again.status, codeOf(again.body)]).toEqual([
      422,
      'UPLOAD_CONTENT_MISMATCH',
    ]);

    // A name dressed to read as a PDF, or ending in another type: refused at
    // the start, before any file is made.
    for (const fileName of [
      'invoice‮fdp.exe',
      'contract.pdf.exe',
      '../contract.pdf',
    ]) {
      const answer = await start(scout, {
        ownerKind: 'player-document',
        ownerId: players[0],
        fileName,
        type: 'application/pdf',
        sizeBytes: size,
      });
      expect([fileName, answer.status, answer.body]).toEqual([
        fileName,
        400,
        expect.objectContaining({
          code: 'VALIDATION_FAILED',
          fieldErrors: [expect.objectContaining({ field: '/fileName' })],
        }),
      ]);
    }
  });

  it('an_upload_for_another_tenants_owner_is_not_found', async () => {
    const [a, b] = tenants;
    const [scout, foreignScout] = scouts;
    const count = (tenant: Tenant) =>
      asTenant(tenant.id, (tx) => tx.fileObject.count());
    const before = [await count(a), await count(b)];

    // Another tenant's player, and a player there is not: the same answer.
    const answers = [];
    for (const ownerId of [players[1], randomUUID()]) {
      const answer = await start(scout, {
        ownerKind: 'player-document',
        ownerId,
        fileName: 'contract.pdf',
        type: 'application/pdf',
        sizeBytes: 1024,
      });
      expect(answer.status).toBe(404);
      const { code, message, status } = answer.body as Record<string, unknown>;
      answers.push({ code, message, status });
    }
    expect(answers[0]).toEqual({
      code: 'NOT_FOUND',
      message: expect.any(String) as unknown,
      status: 404,
    });
    expect(answers[1]).toEqual(answers[0]);
    expect([await count(a), await count(b)]).toEqual(before);

    // An upload is its uploader's: not another tenant's member's, nor a
    // colleague's, to complete.
    const upload = await started(scout, players[0], 1024);
    for (const stranger of [foreignScout, otherScout]) {
      const answer = await complete(stranger, upload.id);
      expect([answer.status, codeOf(answer.body)]).toEqual([404, 'NOT_FOUND']);
    }
  });

  it('a_size_mismatch_is_refused', async () => {
    const [a] = tenants;
    const [scout] = scouts;
    const size = 2048;
    const upload = await started(scout, players[0], size);

    // The link takes the declared size, and no other: the store refuses a
    // byte more or a byte less.
    for (const length of [size + 1, size - 1]) {
      expect((await send(upload.put, pdf(length))).status).toBe(403);
    }
    const early = await complete(scout, upload.id);
    expect([early.status, codeOf(early.body)]).toEqual([
      409,
      'UPLOAD_INCOMPLETE',
    ]);

    // A file of another size in quarantine all the same — as a store that
    // did not bind the length would take it: completion refuses it.
    const { file } = await rowsOf(a, upload);
    await admin.send(
      new PutObjectCommand({
        Bucket: store.bucket,
        Key: file.quarantineKey,
        Body: pdf(size + 512),
        ContentType: 'application/pdf',
      }),
    );
    const refused = await complete(scout, upload.id);
    expect([refused.status, codeOf(refused.body)]).toEqual([
      422,
      'UPLOAD_CONTENT_MISMATCH',
    ]);
    expect((await rowsOf(a, upload)).file.quarantineVersionId).toBeNull();

    // And larger than the owner takes: refused before anything is made.
    const tooLarge = await start(scout, {
      ownerKind: 'player-document',
      ownerId: players[0],
      fileName: 'contract.pdf',
      type: 'application/pdf',
      sizeBytes: 25 * 1024 * 1024 + 1,
    });
    expect([tooLarge.status, tooLarge.body]).toEqual([
      400,
      expect.objectContaining({
        fieldErrors: [
          expect.objectContaining({ field: '/sizeBytes', code: 'TOO_BIG' }),
        ],
      }),
    ]);
  });

  it('a_completed_upload_pins_the_version_that_arrived_and_queues_its_scan', async () => {
    const [a] = tenants;
    const [scout] = scouts;
    const size = 8192;
    const name = 'عقد اللاعب 2026.pdf';
    const answer = await start(scout, {
      ownerKind: 'player-document',
      ownerId: players[0],
      fileName: name,
      type: 'application/pdf',
      sizeBytes: size,
    });
    expect(answer.status).toBe(201);
    // It carries a capability to send: no cache keeps it.
    expect(answer.headers['cache-control']).toBe('no-store');
    const upload = dataOf(answer.body) as Upload & { put: Put };
    expect(upload).toMatchObject({
      status: 'UPLOADING',
      ownerKind: 'player-document',
      ownerId: players[0],
      fileName: name,
      type: 'application/pdf',
      sizeBytes: size,
      completedAt: null,
      put: { method: 'PUT', headers: { 'Content-Type': 'application/pdf' } },
    });
    // Its link: into quarantine, ten minutes at most; the upload, an hour.
    expect(new URL(upload.put.url).pathname).toContain(
      `/tenants/${a.id}/quarantine/`,
    );
    const linkLasts = Date.parse(upload.put.expiresAt) - Date.now();
    expect(linkLasts).toBeLessThanOrEqual(10 * 60 * 1000);
    expect(linkLasts).toBeGreaterThan(9 * 60 * 1000);
    const windowLasts =
      Date.parse(upload.expiresAt) - Date.parse(upload.createdAt);
    expect(windowLasts).toBe(60 * 60 * 1000);

    const first = await send(upload.put, pdf(size));
    expect(first.status).toBe(200);
    const key = randomUUID();
    const done = await complete(scout, upload.id, key);
    expect(done.status).toBe(200);
    expect(dataOf(done.body)).toMatchObject({
      id: upload.id,
      status: 'UPLOADED',
      completedAt: expect.any(String) as unknown,
      put: null,
    });

    // The exact version that arrived is pinned, the scan queued once.
    let rows = await rowsOf(a, upload);
    expect(rows.file).toMatchObject({
      status: 'UPLOADED',
      quarantineVersionId: first.versionId,
      sizeBytes: BigInt(size),
      mimeType: 'application/pdf',
      originalName: name,
      classification: 'OPERATIONAL',
      scanVerdict: 'PENDING',
    });
    expect(rows.session).toMatchObject({
      ownerKind: 'player-document',
      ownerId: players[0],
      declaredSize: BigInt(size),
      declaredType: 'application/pdf',
      revision: 2,
    });
    expect(rows.scans).toEqual([
      {
        payloadRefs: { fileObjectId: upload.fileId },
        dedupKey: `file.uploaded:${upload.fileId}`,
      },
    ]);

    // Audited: started and uploaded, the name never in the row.
    const audits = await asTenant(a.id, (tx) =>
      tx.auditLog.findMany({
        where: { entityId: upload.fileId },
        orderBy: { createdAt: 'asc' },
        select: { action: true, newValues: true, userId: true },
      }),
    );
    expect(audits.map(({ action }) => action)).toEqual([
      'file.upload_started',
      'file.uploaded',
    ]);
    expect(audits.every(({ userId }) => userId === scout.id)).toBe(true);
    expect(JSON.stringify(audits)).not.toContain(name);
    expect(audits[1].newValues).toMatchObject({
      status: 'UPLOADED',
      quarantineVersionId: first.versionId,
    });

    // The old link, still valid, sends another file: a new version in the
    // store, and the pinned one unchanged.
    const replay = await send(upload.put, pdf(size));
    expect(replay.status).toBe(200);
    expect(replay.versionId).not.toBe(first.versionId);
    const again = await complete(scout, upload.id, key);
    const other = await complete(scout, upload.id);
    for (const answer of [again, other]) {
      expect(answer.status).toBe(200);
      expect(dataOf(answer.body).status).toBe('UPLOADED');
    }
    rows = await rowsOf(a, upload);
    expect(rows.file.quarantineVersionId).toBe(first.versionId);
    expect(rows.scans).toHaveLength(1);
  });

  it('an_upload_completed_before_its_file_arrives_completes_once_it_has', async () => {
    const [scout] = scouts;
    const size = 1024;
    const upload = await started(scout, players[0], size);
    const key = randomUUID();
    const early = await complete(scout, upload.id, key);
    expect([early.status, codeOf(early.body)]).toEqual([
      409,
      'UPLOAD_INCOMPLETE',
    ]);
    // Not recorded against the key: the same request completes once it has.
    expect((await send(upload.put, pdf(size))).status).toBe(200);
    const done = await complete(scout, upload.id, key);
    expect([done.status, dataOf(done.body).status]).toEqual([200, 'UPLOADED']);
  });

  it('a_retried_start_makes_one_upload_with_a_fresh_link', async () => {
    const [a] = tenants;
    const [scout] = scouts;
    const body = {
      ownerKind: 'player-document',
      ownerId: players[0],
      fileName: 'scan.png',
      type: 'image/png',
      sizeBytes: 512,
    };
    const key = randomUUID();
    const first = await start(scout, body, key);
    const retry = await start(scout, body, key);
    expect([first.status, retry.status]).toEqual([201, 201]);
    expect(dataOf(retry.body).id).toBe(dataOf(first.body).id);
    expect(dataOf(retry.body).put).not.toBeNull();
    const made = await asTenant(a.id, (tx) =>
      tx.uploadSession.count({ where: { id: dataOf(first.body).id } }),
    );
    expect(made).toBe(1);
    // The same key with another declaration: refused, not a second upload.
    const reused = await start(scout, { ...body, sizeBytes: 513 }, key);
    expect([reused.status, codeOf(reused.body)]).toEqual([
      409,
      'IDEMPOTENCY_KEY_REUSED',
    ]);
  });

  it('an_upload_past_its_window_cannot_be_completed', async () => {
    const [a] = tenants;
    const [scout] = scouts;
    const size = 1024;
    const upload = await started(scout, players[0], size);
    expect((await send(upload.put, pdf(size))).status).toBe(200);
    // Its hour, past.
    await asTenant(a.id, (tx) =>
      tx.uploadSession.update({
        where: { id: upload.id },
        data: {
          createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
          expiresAt: new Date(Date.now() - 60 * 60 * 1000),
        },
      }),
    );
    const late = await complete(scout, upload.id);
    expect([late.status, codeOf(late.body)]).toEqual([
      409,
      'INVALID_TRANSITION',
    ]);
    expect((await rowsOf(a, upload)).file.quarantineVersionId).toBeNull();
  });

  it('a_type_the_owner_does_not_take_is_refused', async () => {
    const [scout] = scouts;
    const declare = (type: string, fileName: string) =>
      start(scout, {
        ownerKind: 'player-document',
        ownerId: players[0],
        fileName,
        type,
        sizeBytes: 1024,
      });
    // A type no kind takes: not a declaration at all.
    const html = await declare('text/html', 'page.html');
    expect([html.status, codeOf(html.body)]).toEqual([
      400,
      'VALIDATION_FAILED',
    ]);
    // A type the kind takes, under another type's name.
    const misnamed = await declare('image/png', 'scan.pdf');
    expect([misnamed.status, misnamed.body]).toEqual([
      400,
      expect.objectContaining({
        fieldErrors: [expect.objectContaining({ field: '/fileName' })],
      }),
    ]);
  });
});
