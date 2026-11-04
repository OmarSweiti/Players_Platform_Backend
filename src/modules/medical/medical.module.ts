import { Module } from '@nestjs/common';
import { MedicalController } from './presentation/medical.controller';
import { MedicalRecordRepository } from './infrastructure/repositories/medical-record.repository';
import { MedicalRecords } from './application/ports/medical-records.port';
import { TreatmentSessionRepository } from './infrastructure/repositories/treatment-session.repository';
import { TreatmentSessions } from './application/ports/treatment-sessions.port';
import { CreateMedicalRecordUseCase } from './application/use-cases/create-medical-record.usecase';
import { UpdateMedicalRecordUseCase } from './application/use-cases/update-medical-record.usecase';
import { CreateTreatmentSessionUseCase } from './application/use-cases/create-treatment-session.usecase';
import { UpdateTreatmentSessionUseCase } from './application/use-cases/update-treatment-session.usecase';
import { ReadMedicalRecordsUseCase } from './application/use-cases/read-medical-records.usecase';
import { ArchiveMedicalRecordUseCase } from './application/use-cases/archive-medical-record.usecase';
import { ReadTreatmentSessionsUseCase } from './application/use-cases/read-treatment-sessions.usecase';
import { ChangeTreatmentSessionUseCase } from './application/use-cases/change-treatment-session.usecase';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { behindFeature } from '../../common/feature-flags/feature-gate.guard';

@Module({
  imports: [PrismaModule],
  // Quarantined until its rebuild: FEATURE_MEDICAL (0.1.8; fixes in 0.6.8).
  controllers: behindFeature('medical', [MedicalController]),
  providers: [
    // Ports, and the repositories that implement them (0.4.12)
    { provide: MedicalRecords, useClass: MedicalRecordRepository },
    { provide: TreatmentSessions, useClass: TreatmentSessionRepository },

    // Use Cases
    CreateMedicalRecordUseCase,
    UpdateMedicalRecordUseCase,
    CreateTreatmentSessionUseCase,
    UpdateTreatmentSessionUseCase,
    ReadMedicalRecordsUseCase,
    ArchiveMedicalRecordUseCase,
    ReadTreatmentSessionsUseCase,
    ChangeTreatmentSessionUseCase,
  ],
  exports: [MedicalRecords, TreatmentSessions],
})
export class MedicalModule {}
