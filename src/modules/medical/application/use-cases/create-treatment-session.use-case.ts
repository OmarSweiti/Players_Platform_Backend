import { Injectable } from '@nestjs/common';
import { TreatmentSessionRepository, CreateTreatmentSessionInput } from '../../infrastructure/repositories/treatment-session.repository';

@Injectable()
export class CreateTreatmentSessionUseCase {
  constructor(
    private readonly treatmentSessionRepo: TreatmentSessionRepository,
  ) {}

  async execute(input: CreateTreatmentSessionInput) {
    // Validate session date is not in the past for scheduled sessions
    if (input.status === 'SCHEDULED' && input.sessionDate < new Date()) {
      throw new Error('Cannot schedule a session in the past');
    }

    // Validate duration
    if (input.duration && (input.duration < 15 || input.duration > 480)) {
      throw new Error('Session duration must be between 15 and 480 minutes');
    }

    return await this.treatmentSessionRepo.create(input);
  }
}
