import { Injectable } from '@nestjs/common';
import {
  MedicalRecordRepository,
  CreateMedicalRecordInput,
} from '../../infrastructure/repositories/medical-record.repository';

@Injectable()
export class CreateMedicalRecordUseCase {
  constructor(private readonly medicalRecordRepo: MedicalRecordRepository) {}

  async execute(input: CreateMedicalRecordInput) {
    // Validate injury date is not in the future
    if (input.injuryDate && input.injuryDate > new Date()) {
      throw new Error('Injury date cannot be in the future');
    }

    // Validate recovery dates
    if (
      input.recoveryDate &&
      input.injuryDate &&
      input.recoveryDate < input.injuryDate
    ) {
      throw new Error('Recovery date cannot be before injury date');
    }

    if (
      input.returnToPlayDate &&
      input.injuryDate &&
      input.returnToPlayDate < input.injuryDate
    ) {
      throw new Error('Return to play date cannot be before injury date');
    }

    return await this.medicalRecordRepo.create(input);
  }
}
