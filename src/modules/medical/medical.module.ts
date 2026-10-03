import { Module } from '@nestjs/common';
import { MedicalController } from './presentation/medical.controller';
import { MedicalRecordRepository } from './infrastructure/repositories/medical-record.repository';
import { TreatmentSessionRepository } from './infrastructure/repositories/treatment-session.repository';
import { CreateMedicalRecordUseCase } from './application/use-cases/create-medical-record.use-case';
import { UpdateMedicalRecordUseCase } from './application/use-cases/update-medical-record.use-case';
import { CreateTreatmentSessionUseCase } from './application/use-cases/create-treatment-session.use-case';
import { UpdateTreatmentSessionUseCase } from './application/use-cases/update-treatment-session.use-case';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { behindFeature } from '../../common/feature-flags/feature-gate.guard';

@Module({
  imports: [PrismaModule],
  // Quarantined until its rebuild: FEATURE_MEDICAL (0.1.8; fixes in 0.6.8).
  controllers: behindFeature('medical', [MedicalController]),
  providers: [
    // Repositories
    MedicalRecordRepository,
    TreatmentSessionRepository,

    // Use Cases
    CreateMedicalRecordUseCase,
    UpdateMedicalRecordUseCase,
    CreateTreatmentSessionUseCase,
    UpdateTreatmentSessionUseCase,
  ],
  exports: [MedicalRecordRepository, TreatmentSessionRepository],
})
export class MedicalModule {}
