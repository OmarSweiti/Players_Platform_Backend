import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { WorkerEnv } from '../../config/env.schema';
import { ClamAvScanner } from './clamav.adapter';
import { ScannerPort } from './scanner.port';

// The malware scanner (0.8.4; SR-DOC-004): ClamAV's daemon, from the
// worker's settings. Global, as the storage port is; only the worker
// imports it — the API scans nothing.
@Global()
@Module({
  providers: [
    {
      provide: ScannerPort,
      inject: [ConfigService],
      useFactory: (config: ConfigService<WorkerEnv, true>) =>
        new ClamAvScanner({
          host: config.get('CLAMAV_HOST', { infer: true }),
          port: config.get('CLAMAV_PORT', { infer: true }),
        }),
    },
  ],
  exports: [ScannerPort],
})
export class ScanningModule {}
