import { Injectable } from '@nestjs/common';
import {
  MedicalRecordRepository,
  UpdateMedicalRecordInput,
} from '../../infrastructure/repositories/medical-record.repository';
import {
  ForbiddenError,
  NotFoundError,
  ValidationFailedError,
} from '../../../../common/errors/domain-error';

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
      throw new NotFoundError('Medical record not found');
    }

    // Only medical staff can update confidential records
    if (
      record.isConfidential &&
      !['MEDICAL', 'PHYSIOTHERAPIST', 'SUPER_ADMIN'].includes(userRole)
    ) {
      throw new ForbiddenError(
        'Insufficient permissions to update confidential medical records',
      );
    }

    // Validate dates if updating
    if (
      input.recoveryDate &&
      input.injuryDate &&
      input.recoveryDate < input.injuryDate
    ) {
      throw new ValidationFailedError(
        'Recovery date cannot be before injury date',
        [{ field: '/recoveryDate', code: 'OUT_OF_RANGE' }],
      );
    }

    return await this.medicalRecordRepo.update(id, tenantId, input);
  }
}
