import { Injectable } from '@nestjs/common';
import {
  ForbiddenError,
  InvalidTransitionError,
} from '../../../../common/errors/domain-error';
import { authorizeChange } from '../../../../common/policy/policy';
import type { AuthorizedTenantContext } from '../../../../common/tenancy/tenant-context';
import { TenantTransactions } from '../../../../common/tenancy/tenant-transaction';
import { treatmentSessionPolicy } from '../policies/treatment-session.policy';
import { MedicalPlayers, requirePlayer } from '../ports/medical-players.port';
import { MedicalRecords, requireRecord } from '../ports/medical-records.port';
import {
  TreatmentSessions,
  type UpdateTreatmentSessionInput,
} from '../ports/treatment-sessions.port';

@Injectable()
export class UpdateTreatmentSessionUseCase {
  constructor(
    private readonly tenants: TenantTransactions,
    private readonly treatmentSessionRepo: TreatmentSessions,
    private readonly players: MedicalPlayers,
    private readonly records: MedicalRecords,
  ) {}

  async execute(
    ctx: AuthorizedTenantContext,
    id: string,
    input: UpdateTreatmentSessionInput,
  ) {
    return this.tenants.withTenantTransaction(ctx, async (tx) => {
      authorizeChange(
        ctx,
        treatmentSessionPolicy,
        'update',
        await this.treatmentSessionRepo.findById(tx, ctx, id),
        'Treatment session not found',
        {
          UNRELATED: () =>
            new ForbiddenError(
              'Only the session conductor or medical staff can update this session',
            ),
          STATE: () =>
            new InvalidTransitionError(
              'Cannot update completed treatment sessions',
            ),
        },
      );
      // Moved, only to a player and a record of the tenant (0.6.9).
      if (input.playerId !== undefined) {
        await requirePlayer(this.players, tx, ctx, input.playerId);
      }
      if (input.medicalRecordId !== undefined) {
        await requireRecord(this.records, tx, ctx, input.medicalRecordId);
      }
      return this.treatmentSessionRepo.update(tx, ctx, id, input);
    });
  }
}
