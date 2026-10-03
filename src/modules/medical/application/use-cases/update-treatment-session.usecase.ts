import { Injectable } from '@nestjs/common';
import {
  TreatmentSessionRepository,
  UpdateTreatmentSessionInput,
} from '../../infrastructure/repositories/treatment-session.repository';
import {
  ForbiddenError,
  InvalidTransitionError,
  NotFoundError,
} from '../../../../common/errors/domain-error';

@Injectable()
export class UpdateTreatmentSessionUseCase {
  constructor(
    private readonly treatmentSessionRepo: TreatmentSessionRepository,
  ) {}

  async execute(
    id: string,
    tenantId: string,
    input: UpdateTreatmentSessionInput,
    userId: string,
    userRole: string,
  ) {
    const session = await this.treatmentSessionRepo.findById(id, tenantId);

    if (!session) {
      throw new NotFoundError('Treatment session not found');
    }

    // Only the conductor or medical staff can update
    if (
      session.conductedBy !== userId &&
      !['MEDICAL', 'PHYSIOTHERAPIST', 'SUPER_ADMIN'].includes(userRole)
    ) {
      throw new ForbiddenError(
        'Only the session conductor or medical staff can update this session',
      );
    }

    // Cannot update completed sessions
    if (session.status === 'COMPLETED') {
      throw new InvalidTransitionError(
        'Cannot update completed treatment sessions',
      );
    }

    return await this.treatmentSessionRepo.update(id, tenantId, input);
  }
}
