import { Module } from '@nestjs/common';
import { CLOCK, systemClock } from '../../common/time/clock';
import { UploadOwners } from './application/ports/upload-owners.port';
import { UploadRecords } from './application/ports/upload-records.port';
import { CompleteUploadUseCase } from './application/use-cases/complete-upload.usecase';
import { StartUploadUseCase } from './application/use-cases/start-upload.usecase';
import { UploadOwnerRepository } from './infrastructure/repositories/upload-owner.repository';
import { UploadRepository } from './infrastructure/repositories/upload.repository';
import { UploadsController } from './presentation/uploads.controller';

/**
 * Files (0.8.2–0.8.5): uploads into quarantine (0.8.3); the scan and the
 * promotion (0.8.4) and downloads (0.8.5) join it. The storage port, the
 * outbox, audit and idempotency are global.
 */
@Module({
  controllers: [UploadsController],
  providers: [
    { provide: UploadRecords, useClass: UploadRepository },
    { provide: UploadOwners, useClass: UploadOwnerRepository },
    { provide: CLOCK, useValue: systemClock },
    StartUploadUseCase,
    CompleteUploadUseCase,
  ],
})
export class FilesModule {}
