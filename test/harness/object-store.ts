import {
  CreateBucketCommand,
  GetBucketVersioningCommand,
  PutBucketVersioningCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { S3Settings } from '../../src/infrastructure/storage/s3-storage';

/** The object store the storage port's tests run against (0.8.1). */
export interface ObjectStoreSettings {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/** An S3 client for the test bucket, path-style, as the local gateway needs. */
export function testStoreClient(settings: ObjectStoreSettings): S3Client {
  return new S3Client({
    endpoint: settings.endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

/**
 * The test bucket's settings (S3_*_TEST: scripts/test-database.sh derives
 * them from the local stack, CI sets them), with the bucket made and
 * versioned if it is not yet — as `just up`'s bootstrap makes it locally, and
 * as nothing else makes it in CI. Null when no store is configured.
 */
export async function objectStoreForTests(): Promise<ObjectStoreSettings | null> {
  const {
    S3_ENDPOINT_TEST: endpoint,
    S3_BUCKET_TEST: bucket = 'sadara-test',
    S3_ACCESS_KEY_ID_TEST: accessKeyId,
    S3_SECRET_ACCESS_KEY_TEST: secretAccessKey,
  } = process.env;
  if (!endpoint || !accessKeyId || !secretAccessKey) return null;
  const settings = { endpoint, bucket, accessKeyId, secretAccessKey };
  const client = testStoreClient(settings);
  try {
    try {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
    } catch (error) {
      const name = (error as Error).name;
      if (!['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes(name)) {
        throw error;
      }
    }
    const { Status } = await client.send(
      new GetBucketVersioningCommand({ Bucket: bucket }),
    );
    if (Status !== 'Enabled') {
      await client.send(
        new PutBucketVersioningCommand({
          Bucket: bucket,
          VersioningConfiguration: { Status: 'Enabled' },
        }),
      );
    }
  } finally {
    client.destroy();
  }
  return settings;
}

/** The storage adapter's settings for the test bucket: the API's, as a test boots it. */
export function s3SettingsOf(settings: ObjectStoreSettings): S3Settings {
  return {
    endpoint: settings.endpoint,
    region: 'us-east-1',
    bucket: settings.bucket,
    accessKeyId: settings.accessKeyId,
    secretAccessKey: settings.secretAccessKey,
    forcePathStyle: true,
  };
}
