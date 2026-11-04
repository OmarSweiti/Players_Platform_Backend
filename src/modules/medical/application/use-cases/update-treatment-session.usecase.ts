import { Injectable } from '@nestjs/common';
import {
  ForbiddenError,
  InvalidTransitionError,
  NotFoundError,
} from '../../../../common/errors/domain-error';
import {
  actingMemberOf,
  type AuthorizedTenantContext,
} from '../../../../common/tenancy/tenant-context';
import { TenantTransactions } from '../../../../common/tenancy/tenant-transaction';
import {
  TreatmentSessions,
  type UpdateTreatmentSessionInput,
} from '../ports/treatment-sessions.port';

@Injectable()
export class UpdateTreatmentSessionUseCase {
  constructor(
    private readonly tenants: TenantTransactions,
    private readonly treatmentSessionRepo: TreatmentSessions,
  ) {}

  /** `memberRole` is the signed-in member's, from the session. */
  async execute(
    ctx: AuthorizedTenantContext,
    id: string,
    input: UpdateTreatmentSessionInput,
    memberRole: string,
  ) {
    const memberId = actingMemberOf(ctx);
    return this.tenants.withTenantTransaction(ctx, async (tx) => {
      const session = await this.treatmentSessionRepo.findById(tx, ctx, id);
      if (!session) {
        throw new NotFoundError('Treatment session not found');
      }

      // Only the conductor or medical staff can update
      if (
        session.conductedBy !== memberId &&
        !['MEDICAL', 'PHYSIOTHERAPIST', 'SUPER_ADMIN'].includes(memberRole)
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

      return this.treatmentSessionRepo.update(tx, ctx, id, input);
    });
  }
}
