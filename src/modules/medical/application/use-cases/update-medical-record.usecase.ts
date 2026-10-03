import { Injectable } from '@nestjs/common';
import {
  MedicalRecordRepository,
  UpdateMedicalRecordInput,
} from '../../infrastructure/repositories/medical-record.repository';

@Injectable()
export class UpdateMedicalRecordUseCase {
  constructor(private readonly medicalRecordRepo: MedicalRecordRepository) {}

  async execute(
    id: string,
    tenantId: string,
    input: UpdateMedicalRecordInput,
    userId: string,
    userRole: string,
  ) {
    const record = await this.medicalRecordRepo.findById(id, tenantId);

    if (!record) {
      throw new Error('Medical record not found');
    }

    // Only medical staff can update confidential records
    if (
      record.isConfidential &&
      !['MEDICAL', 'PHYSIOTHERAPIST', 'SUPER_ADMIN'].includes(userRole)
    ) {
      throw new Error(
        'Insufficient permissions to update confidential medical records',
      );
    }

    // Validate dates if updating
    if (
      input.recoveryDate &&
      input.injuryDate &&
      input.recoveryDate < input.injuryDate
    ) {
      throw new Error('Recovery date cannot be before injury date');
    }

    return await this.medicalRecordRepo.update(id, tenantId, input);
  }
}
