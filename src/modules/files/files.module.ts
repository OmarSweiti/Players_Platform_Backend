import { Module } from '@nestjs/common';
import { CLOCK, systemClock } from '../../common/time/clock';
import { PermissionsModule } from '../users/permissions.module';
import {
  FILE_OWNER_POLICIES,
  FILE_OWNER_POLICY_SET,
} from './application/file-owner.policy';
import { FileDownloads } from './application/ports/file-downloads.port';
import { UploadOwners } from './application/ports/upload-owners.port';
import { UploadRecords } from './application/ports/upload-records.port';
import { CompleteUploadUseCase } from './application/use-cases/complete-upload.usecase';
import { DownloadFileUseCase } from './application/use-cases/download-file.usecase';
import { StartUploadUseCase } from './application/use-cases/start-upload.usecase';
import { FileDownloadRepository } from './infrastructure/repositories/file-download.repository';
import { UploadOwnerRepository } from './infrastructure/repositories/upload-owner.repository';
import { UploadRepository } from './infrastructure/repositories/upload.repository';
import { FilesController } from './presentation/files.controller';
import { UploadsController } from './presentation/uploads.controller';

/**
 * Files (0.8.2–0.8.5): uploads into quarantine (0.8.3) and downloads of the
 * version the scan promoted (0.8.5); the scan itself runs in the worker
 * (`FileScanModule`, 0.8.4). The storage port, the outbox, audit and
 * idempotency are global; a download reads the member's grants from the
 * permissions module.
 */
@Module({
  imports: [PermissionsModule],
  controllers: [UploadsController, FilesController],
  providers: [
    { provide: UploadRecords, useClass: UploadRepository },
    { provide: UploadOwners, useClass: UploadOwnerRepository },
    { provide: FileDownloads, useClass: FileDownloadRepository },
    { provide: FILE_OWNER_POLICY_SET, useValue: FILE_OWNER_POLICIES },
    { provide: CLOCK, useValue: systemClock },
    StartUploadUseCase,
    CompleteUploadUseCase,
    DownloadFileUseCase,
  ],
})
export class FilesModule {}
