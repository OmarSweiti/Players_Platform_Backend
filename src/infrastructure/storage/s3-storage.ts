import type { OnModuleDestroy } from '@nestjs/common';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DependencyUnavailableError } from '../../common/errors/domain-error';
import { assertObjectKey, type ObjectKey } from './object-keys';
import {
  type ObjectHead,
  ObjectNotFound,
  type ObjectVersion,
  type PresignedRequest,
  StoragePort,
} from './storage.port';

/** The store, from the API's settings (Env, S3_*). */
export interface S3Settings {
  readonly endpoint: string;
  /**
   * Where a browser reaches the store, if not at `endpoint` (0.8.3): links
   * are signed for it, and the API's own calls still go to `endpoint`.
   */
  readonly publicEndpoint?: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
}

/** The longest a link may last: an upload's minutes, never longer (ADR-0009). */
export const MAX_LINK_SECONDS = 15 * 60;
/** The most a ranged read returns: enough for a file's magic bytes, bounded. */
export const MAX_RANGE_BYTES = 1024 * 1024;
/** The largest object one PUT may carry, as S3 bounds it: 5 GiB. */
export const MAX_PUT_BYTES = 5 * 1024 ** 3;

/** A type as a client declares it, `type/subtype`, with nothing that could end a header. */
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

/** A request for a link or a range out of bounds: a programming error. */
export class StorageRequestRefused extends Error {
  constructor(reason: string) {
    super(`storage request refused: ${reason}`);
    this.name = 'StorageRequestRefused';
  }
}

function assertLifetime(seconds: number): void {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_LINK_SECONDS) {
    throw new StorageRequestRefused(
      `a link lasts 1 to ${MAX_LINK_SECONDS} seconds`,
    );
  }
}

function assertVersion(version: ObjectVersion): void {
  assertObjectKey(version.key);
  if (version.versionId === '') {
    throw new StorageRequestRefused('a version is named by its id');
  }
}

/**
 * `attachment`, with the name as a browser saves it (RFC 6266): an ASCII
 * fallback, and the name itself in UTF-8 (RFC 8187) — an Arabic name too.
 */
export function attachmentNamed(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_').slice(0, 150);
  const utf8 = encodeURIComponent(name.slice(0, 150)).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${utf8}`;
}

const NOT_FOUND = new Set(['NoSuchKey', 'NoSuchVersion', 'NotFound']);

/**
 * The storage port over S3 (0.8.1; ADR-0009, ADR-0020), through the AWS SDK:
 * the local Versity gateway, or any S3-compatible provider. Checksums are
 * computed only where S3 requires them, so a presigned upload asks the
 * client for nothing beyond its declared type. A missing object or version
 * is `ObjectNotFound`; any other failure of the store, a
 * `DependencyUnavailableError` (503), naming only its class.
 */
export class S3Storage extends StoragePort implements OnModuleDestroy {
  private readonly client: S3Client;
  /** Signs links for where a browser reaches the store; it sends nothing. */
  private readonly signer: S3Client;

  constructor(private readonly settings: S3Settings) {
    super();
    const clientFor = (endpoint: string) =>
      new S3Client({
        endpoint,
        region: settings.region,
        forcePathStyle: settings.forcePathStyle,
        credentials: {
          accessKeyId: settings.accessKeyId,
          secretAccessKey: settings.secretAccessKey,
        },
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
        maxAttempts: 3,
      });
    this.client = clientFor(settings.endpoint);
    this.signer =
      settings.publicEndpoint === undefined
        ? this.client
        : clientFor(settings.publicEndpoint);
  }

  async presignPut(
    key: ObjectKey,
    options: {
      readonly contentType: string;
      readonly contentLength: number;
      readonly expiresInSeconds: number;
    },
  ): Promise<PresignedRequest> {
    assertObjectKey(key);
    assertLifetime(options.expiresInSeconds);
    if (!MEDIA_TYPE.test(options.contentType)) {
      throw new StorageRequestRefused('not a media type');
    }
    if (
      !Number.isSafeInteger(options.contentLength) ||
      options.contentLength < 1 ||
      options.contentLength > MAX_PUT_BYTES
    ) {
      throw new StorageRequestRefused(
        `one PUT carries 1 to ${MAX_PUT_BYTES} bytes`,
      );
    }
    // The type and the length are signed: the store refuses a body that
    // differs in either (0.8.3), so the link carries only what was declared.
    const url = await getSignedUrl(
      this.signer,
      new PutObjectCommand({
        Bucket: this.settings.bucket,
        Key: key,
        ContentType: options.contentType,
        ContentLength: options.contentLength,
      }),
      {
        expiresIn: options.expiresInSeconds,
        signableHeaders: new Set(['content-type', 'content-length']),
      },
    );
    return {
      method: 'PUT',
      url,
      headers: { 'Content-Type': options.contentType },
      expiresAt: new Date(Date.now() + options.expiresInSeconds * 1000),
    };
  }

  async presignGet(
    version: ObjectVersion,
    options: {
      readonly expiresInSeconds: number;
      readonly downloadName?: string;
    },
  ): Promise<PresignedRequest> {
    assertVersion(version);
    assertLifetime(options.expiresInSeconds);
    const url = await getSignedUrl(
      this.signer,
      new GetObjectCommand({
        Bucket: this.settings.bucket,
        Key: version.key,
        VersionId: version.versionId,
        ResponseContentDisposition:
          options.downloadName === undefined
            ? undefined
            : attachmentNamed(options.downloadName),
      }),
      { expiresIn: options.expiresInSeconds },
    );
    return {
      method: 'GET',
      url,
      headers: {},
      expiresAt: new Date(Date.now() + options.expiresInSeconds * 1000),
    };
  }

  async head(key: ObjectKey, versionId?: string): Promise<ObjectHead | null> {
    assertObjectKey(key);
    try {
      const out = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.settings.bucket,
          Key: key,
          VersionId: versionId,
        }),
      );
      return {
        key,
        versionId: this.versionOf(out.VersionId),
        sizeBytes: Number(out.ContentLength ?? 0),
        contentType: out.ContentType ?? null,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw unavailable(error);
    }
  }

  async readRange(
    version: ObjectVersion,
    start: number,
    end: number,
  ): Promise<Buffer> {
    assertVersion(version);
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end < start ||
      end - start + 1 > MAX_RANGE_BYTES
    ) {
      throw new StorageRequestRefused(
        `a range is 1 to ${MAX_RANGE_BYTES} bytes from 0`,
      );
    }
    const out = await this.call(() =>
      this.client.send(
        new GetObjectCommand({
          Bucket: this.settings.bucket,
          Key: version.key,
          VersionId: version.versionId,
          Range: `bytes=${start}-${end}`,
        }),
      ),
    );
    return Buffer.from((await out.Body?.transformToByteArray()) ?? []);
  }

  async copy(from: ObjectVersion, to: ObjectKey): Promise<ObjectVersion> {
    assertVersion(from);
    assertObjectKey(to);
    const out = await this.call(() =>
      this.client.send(
        new CopyObjectCommand({
          Bucket: this.settings.bucket,
          Key: to,
          CopySource: `${this.settings.bucket}/${from.key}?versionId=${encodeURIComponent(from.versionId)}`,
        }),
      ),
    );
    return { key: to, versionId: this.versionOf(out.VersionId) };
  }

  async deleteVersion(version: ObjectVersion): Promise<void> {
    assertVersion(version);
    await this.call(() =>
      this.client.send(
        new DeleteObjectCommand({
          Bucket: this.settings.bucket,
          Key: version.key,
          VersionId: version.versionId,
        }),
      ),
    );
  }

  onModuleDestroy(): void {
    this.client.destroy();
    if (this.signer !== this.client) this.signer.destroy();
  }

  /** A version id, which a versioned bucket always answers with. */
  private versionOf(versionId: string | undefined): string {
    if (versionId === undefined || versionId === '') {
      throw new DependencyUnavailableError(
        'the object store answered no version: is the bucket versioned?',
      );
    }
    return versionId;
  }

  private async call<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      if (isNotFound(error)) throw new ObjectNotFound();
      throw unavailable(error);
    }
  }
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof S3ServiceException &&
    (NOT_FOUND.has(error.name) || error.$metadata.httpStatusCode === 404)
  );
}

function unavailable(error: unknown): DependencyUnavailableError {
  const name = error instanceof Error ? error.name : 'unknown';
  return new DependencyUnavailableError(`the object store failed: ${name}`);
}
