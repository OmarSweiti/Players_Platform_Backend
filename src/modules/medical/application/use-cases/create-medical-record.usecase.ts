import { Injectable } from '@nestjs/common';
import {
  MedicalRecordRepository,
  CreateMedicalRecordInput,
} from '../../infrastructure/repositories/medical-record.repository';
import { ValidationFailedError } from '../../../../common/errors/domain-error';

@Injectable()
export class CreateMedicalRecordUseCase {
  constructor(private readonly medicalRecordRepo: MedicalRecordRepository) {}

  async execute(input: CreateMedicalRecordInput) {
    // Validate injury date is not in the future
    if (input.injuryDate && input.injuryDate > new Date()) {
      throw new ValidationFailedError('Injury date cannot be in the future', [
        { field: '/injuryDate', code: 'OUT_OF_RANGE' },
      ]);
    }

    // Validate recovery dates
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

    if (
      input.returnToPlayDate &&
      input.injuryDate &&
      input.returnToPlayDate < input.injuryDate
    ) {
      throw new ValidationFailedError(
        'Return to play date cannot be before injury date',
        [{ field: '/returnToPlayDate', code: 'OUT_OF_RANGE' }],
      );
    }

    return await this.medicalRecordRepo.create(input);
  }
}
