import type { ObjectKey } from './object-keys';

/**
 * One exact version of an object (ADR-0009): its key, and the store's own
 * version id — an opaque string, never parsed (ADR-0020).
 */
export interface ObjectVersion {
  readonly key: ObjectKey;
  readonly versionId: string;
}

/** A request the client makes itself, straight to the store: the URL, the headers it must send, and when it stops working. */
export interface PresignedRequest {
  readonly method: 'PUT' | 'GET';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: Date;
}

/** What the store says of one version of an object. */
export interface ObjectHead extends ObjectVersion {
  readonly sizeBytes: number;
  readonly contentType: string | null;
}

/** An object or version the store does not hold. */
export class ObjectNotFound extends Error {
  constructor() {
    super('the store holds no such object or version');
    this.name = 'ObjectNotFound';
  }
}

/**
 * Private, versioned object storage (0.8.1; ADR-0009, SR-DOC-006), behind a
 * port: the S3 adapter (s3-storage.ts) against the local Versity gateway or
 * the production provider (1.10.1). Every read names an object's **version**,
 * so a later write to the same key never changes what it returns, and every
 * key comes from the key builder (object-keys.ts), never from a file's name.
 * Links last seconds or minutes: a caller gives each its lifetime.
 */
export abstract class StoragePort {
  /** A presigned PUT of one object, of the type the client declared: an upload into quarantine. */
  abstract presignPut(
    key: ObjectKey,
    options: {
      readonly contentType: string;
      readonly expiresInSeconds: number;
    },
  ): Promise<PresignedRequest>;

  /** A presigned GET pinned to one version: a download. */
  abstract presignGet(
    version: ObjectVersion,
    options: {
      readonly expiresInSeconds: number;
      /** The name the browser saves it as: display metadata only. */
      readonly downloadName?: string;
    },
  ): Promise<PresignedRequest>;

  /** What the store holds of `key`: its newest version, or the one named; null if none. */
  abstract head(key: ObjectKey, versionId?: string): Promise<ObjectHead | null>;

  /** Bytes `start` to `end`, inclusive, of one version: a file's magic bytes, say. */
  abstract readRange(
    version: ObjectVersion,
    start: number,
    end: number,
  ): Promise<Buffer>;

  /** Copies one exact version to `to`, inside the store; the copy's own version. */
  abstract copy(from: ObjectVersion, to: ObjectKey): Promise<ObjectVersion>;

  /** Deletes one version, and only it. */
  abstract deleteVersion(version: ObjectVersion): Promise<void>;
}
