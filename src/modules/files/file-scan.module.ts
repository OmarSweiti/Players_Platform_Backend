import { Module } from '@nestjs/common';
import { CLOCK, systemClock } from '../../common/time/clock';
import { FileScans } from './application/ports/file-scans.port';
import { ScanFileConsumer } from './application/scan-file.handler';
import { FileScanRepository } from './infrastructure/repositories/file-scan.repository';

// The scan and the promotion, for the worker (0.8.4): the consumer and the
// files it reads and moves. No route. The store and the scanner it uses come
// from the worker's global StorageModule and ScanningModule.
@Module({
  providers: [
    { provide: FileScans, useClass: FileScanRepository },
    { provide: CLOCK, useValue: systemClock },
    ScanFileConsumer,
  ],
  exports: [ScanFileConsumer],
})
export class FileScanModule {}
