import { createHash, randomUUID } from 'node:crypto';
import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type {
  FileClassification,
  FileStatus,
  ScanVerdict,
  Tenant,
  User,
} from '@prisma/client';
import { asTenant } from './fixtures';

/** A file as the scan leaves it, seeded: its row, and its bytes where the row says. */
export interface SeededFile {
  readonly fileId: string;
  readonly objectKey: string | null;
  readonly objectVersionId: string | null;
  readonly sha256: Buffer;
  readonly bytes: Buffer;
}

export interface FileSeed {
  readonly bytes: Buffer;
  readonly fileName?: string;
  readonly type?: string;
  readonly classification?: FileClassification;
  /** What its upload names as its owner: a kind and an id. */
  readonly owner: { readonly kind: string; readonly id: string };
  /**
   * How far its scan went: promoted (`READY`, `CLEAN`, its bytes under
   * `objects/`), or one of the ends that promotes nothing.
   */
  readonly outcome?: 'promoted' | 'pending' | 'infected' | 'failed';
}

const OUTCOMES: Record<
  NonNullable<FileSeed['outcome']>,
  { status: FileStatus; scanVerdict: ScanVerdict }
> = {
  promoted: { status: 'READY', scanVerdict: 'CLEAN' },
  pending: { status: 'UPLOADED', scanVerdict: 'PENDING' },
  infected: { status: 'REJECTED', scanVerdict: 'INFECTED' },
  failed: { status: 'FAILED', scanVerdict: 'ERROR' },
};

/**
 * A file `member` uploaded in `tenant`, its scan's outcome seeded as 0.8.4
 * leaves it — for tests of what reads files, not of the scan, which
 * test/files/scanning.integration-spec.ts drives through ClamAV. A promoted
 * file's bytes are put under the tenant's `objects/` in the test bucket, and
 * the row records that exact version and their SHA-256; its quarantine is a
 * key and a version only, which nothing here reads.
 */
export async function seedFile(
  store: { readonly client: S3Client; readonly bucket: string },
  tenant: Tenant,
  member: User,
  seed: FileSeed,
): Promise<SeededFile> {
  const outcome = seed.outcome ?? 'promoted';
  const { status, scanVerdict } = OUTCOMES[outcome];
  const type = seed.type ?? 'application/pdf';
  const sha256 = createHash('sha256').update(seed.bytes).digest();
  let objectKey: string | null = null;
  let objectVersionId: string | null = null;
  if (outcome === 'promoted') {
    objectKey = `tenants/${tenant.id}/objects/${randomUUID()}`;
    const put = await store.client.send(
      new PutObjectCommand({
        Bucket: store.bucket,
        Key: objectKey,
        Body: seed.bytes,
        ContentType: type,
      }),
    );
    objectVersionId = put.VersionId ?? null;
    if (objectVersionId === null) {
      throw new TypeError('the test bucket must be versioned');
    }
  }
  const now = new Date();
  const fileId = await asTenant(tenant.id, async (tx) => {
    const file = await tx.fileObject.create({
      data: {
        tenantId: tenant.id,
        quarantineKey: `tenants/${tenant.id}/quarantine/${randomUUID()}`,
        quarantineVersionId: `seeded-${randomUUID()}`,
        objectKey,
        objectVersionId,
        sha256: outcome === 'promoted' ? new Uint8Array(sha256) : null,
        sizeBytes: BigInt(seed.bytes.length),
        mimeType: type,
        originalName: seed.fileName ?? 'contract.pdf',
        status,
        scanVerdict,
        scanAttempts: outcome === 'pending' ? 0 : 1,
        scannedAt: outcome === 'pending' ? null : now,
        scanFinding: outcome === 'infected' ? 'Eicar-Signature' : null,
        finalizedAt: outcome === 'promoted' ? now : null,
        classification: seed.classification ?? 'OPERATIONAL',
        createdById: member.id,
      },
      select: { id: true },
    });
    await tx.uploadSession.create({
      data: {
        tenantId: tenant.id,
        fileObjectId: file.id,
        createdById: member.id,
        declaredSize: BigInt(seed.bytes.length),
        declaredType: type,
        ownerKind: seed.owner.kind,
        ownerId: seed.owner.id,
        expiresAt: new Date(now.getTime() + 3_600_000),
        finalizedAt: now,
      },
    });
    return file.id;
  });
  return { fileId, objectKey, objectVersionId, sha256, bytes: seed.bytes };
}
