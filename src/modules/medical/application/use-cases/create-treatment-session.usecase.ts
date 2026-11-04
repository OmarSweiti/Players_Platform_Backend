import { Injectable } from '@nestjs/common';
import { ValidationFailedError } from '../../../../common/errors/domain-error';
import {
  actingMemberOf,
  type AuthorizedTenantContext,
} from '../../../../common/tenancy/tenant-context';
import { TenantTransactions } from '../../../../common/tenancy/tenant-transaction';
import {
  type CreateTreatmentSessionInput,
  TreatmentSessions,
} from '../ports/treatment-sessions.port';

@Injectable()
export class CreateTreatmentSessionUseCase {
  constructor(
    private readonly tenants: TenantTransactions,
    private readonly treatmentSessionRepo: TreatmentSessions,
  ) {}

  /** The session is the context's tenant's, conducted by the acting member. */
  async execute(
    ctx: AuthorizedTenantContext,
    input: Omit<CreateTreatmentSessionInput, 'conductedBy'>,
  ) {
    // Validate session date is not in the past for scheduled sessions
    if (input.status === 'SCHEDULED' && input.sessionDate < new Date()) {
      throw new ValidationFailedError('Cannot schedule a session in the past', [
        { field: '/sessionDate', code: 'OUT_OF_RANGE' },
      ]);
    }

    // Validate duration
    if (input.duration && (input.duration < 15 || input.duration > 480)) {
      throw new ValidationFailedError(
        'Session duration must be between 15 and 480 minutes',
        [{ field: '/duration', code: 'OUT_OF_RANGE' }],
      );
    }

    const conductedBy = actingMemberOf(ctx);
    return this.tenants.withTenantTransaction(ctx, (tx) =>
      this.treatmentSessionRepo.create(tx, ctx, { ...input, conductedBy }),
    );
  }
}
