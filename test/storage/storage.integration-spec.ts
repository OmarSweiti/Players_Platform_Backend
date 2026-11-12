import { randomBytes, randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  ListObjectVersionsCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { AuthorizedTenantContext } from '../../src/common/tenancy/tenant-context';
import {
  newObjectKey,
  type ObjectKey,
  ObjectKeyRefused,
  objectKeyOf,
} from '../../src/infrastructure/storage/object-keys';
import {
  MAX_LINK_SECONDS,
  MAX_PUT_BYTES,
  MAX_RANGE_BYTES,
  S3Storage,
  StorageRequestRefused,
} from '../../src/infrastructure/storage/s3-storage';
import {
  ObjectNotFound,
  type ObjectVersion,
} from '../../src/infrastructure/storage/storage.port';
import { testContext } from '../harness/fixtures';
import {
  type ObjectStoreSettings,
  s3SettingsOf,
  testStoreClient,
} from '../harness/object-store';

// The storage port (0.8.1; ADR-0009, ADR-0020, SR-DOC-006), against the local
// stack's object store — the Versity gateway CI runs too — in its test bucket,
// private and versioned. Two tenants' contexts; every byte is random, every
// object the run writes is deleted afterwards, every version of it.

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('the storage port', () => {
  let settings: ObjectStoreSettings;
  let storage: S3Storage;
  let admin: S3Client;
  const tenants: AuthorizedTenantContext[] = [
    testContext(randomUUID()),
    testContext(randomUUID()),
  ];

  beforeAll(() => {
    const store = inject('objectStore');
    // No store, no test: S3_*_TEST, from the local stack or CI.
    if (store === null) {
      return expect.unreachable(
        'the storage tests need the object store: run `just up`, or set S3_*_TEST',
      );
    }
    settings = store;
    storage = new S3Storage(s3SettingsOf(settings));
    admin = testStoreClient(settings);
  });

  afterAll(async () => {
    // Every version this run wrote, under its two tenants' prefixes.
    for (const ctx of tenants) {
      const listed = await admin.send(
        new ListObjectVersionsCommand({
          Bucket: settings.bucket,
          Prefix: `tenants/${ctx.tenantId}/`,
        }),
      );
      for (const v of [
        ...(listed.Versions ?? []),
        ...(listed.DeleteMarkers ?? []),
      ]) {
        await admin.send(
          new DeleteObjectCommand({
            Bucket: settings.bucket,
            Key: v.Key,
            VersionId: v.VersionId,
          }),
        );
      }
    }
    storage?.onModuleDestroy();
    admin?.destroy();
  });

  /** An upload through a presigned PUT, as a browser makes it; the version it made. */
  async function upload(
    key: ObjectKey,
    body: Buffer,
    contentType = 'application/pdf',
  ): Promise<ObjectVersion> {
    const put = await storage.presignPut(key, {
      contentType,
      contentLength: body.length,
      expiresInSeconds: 60,
    });
    const answer = await fetch(put.url, {
      method: put.method,
      headers: put.headers,
      body: new Uint8Array(body),
    });
    expect(answer.status).toBe(200);
    const head = await storage.head(key);
    return { key, versionId: head!.versionId };
  }

  /** A presigned GET, followed: its status and bytes. */
  async function download(version: ObjectVersion, downloadName?: string) {
    const get = await storage.presignGet(version, {
      expiresInSeconds: 60,
      downloadName,
    });
    const answer = await fetch(get.url);
    return {
      status: answer.status,
      bytes: Buffer.from(await answer.arrayBuffer()),
      disposition: answer.headers.get('content-disposition'),
    };
  }

  it('object_keys_are_opaque_and_tenant_prefixed', async () => {
    const [a, b] = tenants;
    const keys = [
      newObjectKey(a, 'quarantine'),
      newObjectKey(a, 'quarantine'),
      newObjectKey(a, 'objects'),
      newObjectKey(b, 'quarantine'),
    ];
    // tenants/{the context's tenant}/{area}/{a random UUID}: no name, no path
    // a caller chose, and never the same twice.
    for (const [key, ctx, area] of [
      [keys[0], a, 'quarantine'],
      [keys[1], a, 'quarantine'],
      [keys[2], a, 'objects'],
      [keys[3], b, 'quarantine'],
    ] as const) {
      const [prefix, tenant, place, id] = key.split('/');
      expect([prefix, tenant, place]).toEqual(['tenants', ctx.tenantId, area]);
      expect(id).toMatch(UUID_V4);
    }
    expect(new Set(keys).size).toBe(keys.length);

    // A key read back is taken only as the builder made it, in its area, for
    // its own tenant.
    expect(objectKeyOf(a, keys[0], 'quarantine')).toBe(keys[0]);
    for (const [value, area] of [
      [keys[3], 'quarantine'], // another tenant's
      [keys[0], 'objects'], // another area
      [`tenants/${a.tenantId}/quarantine/contract.pdf`, 'quarantine'],
      [`tenants/${a.tenantId}/quarantine/../../${b.tenantId}`, 'quarantine'],
      [`/tenants/${a.tenantId}/quarantine/${randomUUID()}`, 'quarantine'],
      [`tenants/${a.tenantId}/quarantine/${randomUUID()}/x`, 'quarantine'],
    ] as const) {
      expect(() => objectKeyOf(a, value, area)).toThrow(ObjectKeyRefused);
    }

    // And the port takes no other key, whatever its type says.
    for (const forged of [
      'contract.pdf',
      `tenants/${a.tenantId}/quarantine/contract.pdf`,
    ]) {
      await expect(
        storage.presignPut(forged as ObjectKey, {
          contentType: 'application/pdf',
          contentLength: 16,
          expiresInSeconds: 60,
        }),
      ).rejects.toThrow(ObjectKeyRefused);
      await expect(storage.head(forged as ObjectKey)).rejects.toThrow(
        ObjectKeyRefused,
      );
    }

    // What a key names holds what was put there, under that tenant alone.
    const version = await upload(keys[3], randomBytes(64));
    expect(await storage.head(keys[3])).toMatchObject({
      key: keys[3],
      sizeBytes: 64,
      contentType: 'application/pdf',
    });
    expect(version.key.startsWith(`tenants/${b.tenantId}/`)).toBe(true);
  });

  it('the_bucket_refuses_anonymous_reads', async () => {
    const [a] = tenants;
    const key = newObjectKey(a, 'objects');
    const bytes = randomBytes(128);
    const version = await upload(key, bytes);
    const at = (path: string) =>
      `${settings.endpoint}/${settings.bucket}${path}`;

    // Unsigned, nothing: not the object, not a version, not the listing, and
    // no write.
    for (const [method, url] of [
      ['GET', at(`/${key}`)],
      ['GET', at(`/${key}?versionId=${encodeURIComponent(version.versionId)}`)],
      ['HEAD', at(`/${key}`)],
      ['GET', at('?list-type=2')],
      ['GET', at('?versions')],
      ['PUT', at(`/${newObjectKey(a, 'quarantine')}`)],
    ] as const) {
      const answer = await fetch(url, {
        method,
        body: method === 'PUT' ? 'anonymous' : undefined,
      });
      expect([
        method,
        url.replace(settings.endpoint, ''),
        answer.status,
      ]).toEqual([method, url.replace(settings.endpoint, ''), 403]);
    }
    // Signed and pinned to its version, it is served.
    expect(await download(version)).toMatchObject({ status: 200, bytes });
    // The bucket is versioned.
    const { Status } = await admin.send(
      new GetBucketVersioningCommand({ Bucket: settings.bucket }),
    );
    expect(Status).toBe('Enabled');
  });

  it('a_read_is_pinned_to_its_version', async () => {
    const [, b] = tenants;
    const key = newObjectKey(b, 'quarantine');
    const first = randomBytes(256);
    const second = randomBytes(300);
    const v1 = await upload(key, first);
    // The same key written again — a replayed upload: a new version, and the
    // first still reads as it was.
    const v2 = await upload(key, second);
    expect(v2.versionId).not.toBe(v1.versionId);
    expect(await download(v1)).toMatchObject({ status: 200, bytes: first });
    expect(await download(v2)).toMatchObject({ status: 200, bytes: second });
    expect(await storage.head(key, v1.versionId)).toMatchObject({
      versionId: v1.versionId,
      sizeBytes: 256,
    });
    expect(await storage.head(key)).toMatchObject({
      versionId: v2.versionId,
      sizeBytes: 300,
    });
    // A ranged read of one version: its first bytes, and a middle span.
    expect(await storage.readRange(v1, 0, 7)).toEqual(first.subarray(0, 8));
    expect(await storage.readRange(v1, 100, 149)).toEqual(
      first.subarray(100, 150),
    );
    // A whole version, streamed (0.8.4): the scan's read, pinned as well.
    const streamed: Buffer[] = [];
    for await (const chunk of await storage.openVersion(v1)) {
      streamed.push(chunk as Buffer);
    }
    expect(Buffer.concat(streamed)).toEqual(first);
    await storage.deleteVersion(v1);
    await expect(storage.openVersion(v1)).rejects.toThrow(ObjectNotFound);
  });

  it('a_server_side_copy_takes_one_exact_version', async () => {
    const [a] = tenants;
    const quarantined = newObjectKey(a, 'quarantine');
    const scanned = randomBytes(512);
    const v1 = await upload(quarantined, scanned);
    await upload(quarantined, randomBytes(512)); // written again after the scan
    const promoted = await storage.copy(v1, newObjectKey(a, 'objects'));
    expect(promoted.key).toMatch(new RegExp(`^tenants/${a.tenantId}/objects/`));
    expect(await download(promoted)).toMatchObject({
      status: 200,
      bytes: scanned,
    });
  });

  it('deleting_a_version_leaves_the_others', async () => {
    const [a] = tenants;
    const key = newObjectKey(a, 'quarantine');
    const kept = randomBytes(32);
    const v1 = await upload(key, kept);
    const v2 = await upload(key, randomBytes(32));
    await storage.deleteVersion(v2);
    expect(await storage.head(key, v2.versionId)).toBeNull();
    expect(await download(v1)).toMatchObject({ status: 200, bytes: kept });
    // Gone: a read of it says so, a head finds nothing.
    await expect(storage.readRange(v2, 0, 1)).rejects.toThrow(ObjectNotFound);
    expect(await storage.head(newObjectKey(a, 'objects'))).toBeNull();
  });

  it('a_link_is_short_lived_and_takes_only_what_it_was_signed_for', async () => {
    const [a] = tenants;
    const key = newObjectKey(a, 'quarantine');
    // An upload of another type than the one declared: refused.
    const put = await storage.presignPut(key, {
      contentType: 'application/pdf',
      contentLength: 25,
      expiresInSeconds: 60,
    });
    const swapped = await fetch(put.url, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/html' },
      body: '<script>alert(1)</script>',
    });
    expect(swapped.status).toBe(403);
    // Of another size than the one declared (0.8.3): refused, one byte over
    // and one byte short.
    for (const length of [26, 24]) {
      const resized = await fetch(put.url, {
        method: 'PUT',
        headers: put.headers,
        body: new Uint8Array(randomBytes(length)),
      });
      expect(resized.status).toBe(403);
    }
    expect(await storage.head(key)).toBeNull();

    // A download, named in Arabic for the browser to save.
    const version = await upload(key, randomBytes(16));
    const named = await download(version, 'تقرير "الفحص".pdf');
    expect(named.status).toBe(200);
    expect(named.disposition).toContain('attachment;');
    expect(named.disposition).toContain(
      `filename*=UTF-8''${encodeURIComponent('تقرير "الفحص".pdf')}`,
    );

    // Past its lifetime, a link is refused.
    const brief = await storage.presignGet(version, { expiresInSeconds: 1 });
    await wait(2_500);
    expect((await fetch(brief.url)).status).toBe(403);

    // Links last minutes at most; ranges are bounded; a type is a type.
    for (const seconds of [0, MAX_LINK_SECONDS + 1, 1.5]) {
      await expect(
        storage.presignGet(version, { expiresInSeconds: seconds }),
      ).rejects.toThrow(StorageRequestRefused);
    }
    await expect(
      storage.readRange(version, 0, MAX_RANGE_BYTES),
    ).rejects.toThrow(StorageRequestRefused);
    await expect(
      storage.presignPut(key, {
        contentType: 'text/html\r\nX-Injected: 1',
        contentLength: 16,
        expiresInSeconds: 60,
      }),
    ).rejects.toThrow(StorageRequestRefused);
    // A PUT carries one byte to 5 GiB, a whole number of them.
    for (const contentLength of [0, 1.5, MAX_PUT_BYTES + 1]) {
      await expect(
        storage.presignPut(key, {
          contentType: 'application/pdf',
          contentLength,
          expiresInSeconds: 60,
        }),
      ).rejects.toThrow(StorageRequestRefused);
    }
  });

  it('a_link_names_where_a_browser_reaches_the_store', async () => {
    // Signed for the public endpoint (0.8.3): the browser's way in, while the
    // API's own calls keep to the endpoint it reaches the store at.
    const proxied = new S3Storage({
      ...s3SettingsOf(settings),
      publicEndpoint: 'https://storage.agency.test',
    });
    try {
      const key = newObjectKey(tenants[0], 'quarantine');
      const put = await proxied.presignPut(key, {
        contentType: 'application/pdf',
        contentLength: 16,
        expiresInSeconds: 60,
      });
      expect(new URL(put.url).origin).toBe('https://storage.agency.test');
      expect(new URL(put.url).pathname).toBe(`/${settings.bucket}/${key}`);
      // What the store holds is still read at its own endpoint.
      expect(await proxied.head(key)).toBeNull();
    } finally {
      proxied.onModuleDestroy();
    }
  });
});
