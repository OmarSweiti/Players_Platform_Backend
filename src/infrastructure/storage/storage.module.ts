import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema';
import { S3Storage } from './s3-storage';
import { StoragePort } from './storage.port';

// Private, versioned object storage (0.8.1; ADR-0009): the storage port over
// S3, from the API's settings. Global, so that the file pipeline's use cases
// (0.8.3–0.8.5) take it as they take the outbox.
@Global()
@Module({
  providers: [
    {
      provide: StoragePort,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new S3Storage({
          endpoint: config.get('S3_ENDPOINT', { infer: true }),
          publicEndpoint: config.get('S3_PUBLIC_ENDPOINT', { infer: true }),
          region: config.get('S3_REGION', { infer: true }),
          bucket: config.get('S3_BUCKET', { infer: true }),
          accessKeyId: config.get('S3_ACCESS_KEY_ID', { infer: true }),
          secretAccessKey: config.get('S3_SECRET_ACCESS_KEY', { infer: true }),
          forcePathStyle: config.get('S3_FORCE_PATH_STYLE', { infer: true }),
        }),
    },
  ],
  exports: [StoragePort],
})
export class StorageModule {}
